require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const jsforce = require('jsforce');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 4 } // 4 hours
  })
);
app.use(express.static(path.join(__dirname, 'public')));

const oauth2Config = {
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  redirectUri: process.env.SF_CALLBACK_URL,
  loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com'
};

function getConnFromSession(req) {
  if (!req.session.sf) return null;
  const conn = new jsforce.Connection({
    oauth2: new jsforce.OAuth2(oauth2Config),
    instanceUrl: req.session.sf.instanceUrl,
    accessToken: req.session.sf.accessToken,
    refreshToken: req.session.sf.refreshToken
  });
  return conn;
}

function requireAuth(req, res, next) {
  if (!req.session.sf) {
    return res.status(401).json({ error: 'Not authenticated. Please log in first.' });
  }
  next();
}

// ---------- AUTH ROUTES ----------

// 1. Login button -> redirect to Salesforce OAuth authorize screen
// Newer Salesforce orgs (External Client Apps) require PKCE, so we generate
// a code verifier here, stash it in the session, and let jsforce derive the
// code_challenge from it for the authorize URL.
app.get('/auth/login', (req, res) => {
  const oauth2 = new jsforce.OAuth2({ ...oauth2Config, useVerifier: true });

  // Save the verifier so /auth/callback (a separate request) can use it later
  req.session.codeVerifier = oauth2.codeVerifier;

  const authUrl = oauth2.getAuthorizationUrl({
    scope: 'api refresh_token',
    state: 'sfValidationToggle'
  });
  res.redirect(authUrl);
});

// 2. Salesforce redirects back here with ?code=...
app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  }

  try {
    const oauth2 = new jsforce.OAuth2(oauth2Config);
    // Re-attach the verifier we generated in /auth/login so the token
    // request includes the matching code_verifier (PKCE requirement).
    if (req.session.codeVerifier) {
      oauth2.codeVerifier = req.session.codeVerifier;
    }

    const conn = new jsforce.Connection({ oauth2 });
    const userInfo = await conn.authorize(code);

    req.session.sf = {
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      instanceUrl: conn.instanceUrl,
      userId: userInfo.id,
      organizationId: userInfo.organizationId
    };

    // Grab username + org name for the dashboard header
    const identity = await conn.identity();
    req.session.sf.username = identity.username;
    req.session.sf.displayName = identity.display_name;

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/whoami', (req, res) => {
  if (!req.session.sf) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    username: req.session.sf.username,
    displayName: req.session.sf.displayName,
    organizationId: req.session.sf.organizationId
  });
});

// ---------- VALIDATION RULE ROUTES ----------

// 3. Get all validation rules on the Account object (via Tooling API)
app.get('/api/rules', requireAuth, async (req, res) => {
  try {
    const conn = getConnFromSession(req);
    const soql = `
      SELECT Id, ValidationName, Active, ErrorMessage, EntityDefinition.DeveloperName
      FROM ValidationRule
      WHERE EntityDefinition.DeveloperName = 'Account'
      ORDER BY ValidationName ASC
    `;
    const result = await conn.tooling.query(soql);

    const rules = result.records.map((r) => ({
      id: r.Id,
      name: r.ValidationName,
      fullName: `Account.${r.ValidationName}`,
      active: r.Active,
      errorMessage: r.ErrorMessage
    }));

    res.json({ rules });
  } catch (err) {
    console.error('Error fetching validation rules:', err);
    res.status(500).json({ error: err.message });
  }
});

// NEW: Create a brand-new validation rule on Account directly from the web app,
// so you don't have to go into Salesforce Setup manually.
app.post('/api/rules/create', requireAuth, async (req, res) => {
  try {
    const { ruleName, errorConditionFormula, errorMessage, active, errorLocation, errorDisplayField } = req.body;

    if (!ruleName || !errorConditionFormula || !errorMessage) {
      return res.status(400).json({
        error: 'ruleName, errorConditionFormula and errorMessage are all required.'
      });
    }

    // Rule names in Salesforce can only contain letters, numbers, underscores
    // and must start with a letter — same constraint the Setup UI enforces.
    const safeRuleName = ruleName.trim().replace(/[^a-zA-Z0-9_]/g, '_');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(safeRuleName)) {
      return res.status(400).json({
        error: 'Rule name must start with a letter and contain only letters, numbers, and underscores.'
      });
    }

    const conn = getConnFromSession(req);
    const fullName = `Account.${safeRuleName}`;

    const metadata = {
      fullName,
      active: active !== false, // default true
      errorConditionFormula,
      errorMessage
    };

    // errorDisplayField is required when errorLocation is "field"; omit for "top of page"
    if (errorDisplayField) {
      metadata.errorDisplayField = errorDisplayField;
    }

    const saveResult = await conn.metadata.create('ValidationRule', metadata);
    const resultArr = Array.isArray(saveResult) ? saveResult : [saveResult];
    const failures = resultArr.filter((r) => !r.success);

    if (failures.length > 0) {
      const messages = failures.map((f) => f.errors?.message || f.message || 'Unknown error');
      return res.status(400).json({ error: messages.join('; ') });
    }

    res.json({ ok: true, fullName, results: resultArr });
  } catch (err) {
    console.error('Error creating validation rule:', err);
    res.status(500).json({ error: err.message });
  }
});

// NEW: Delete a validation rule from Account.
app.post('/api/rules/delete', requireAuth, async (req, res) => {
  try {
    const { fullName } = req.body;
    if (!fullName) {
      return res.status(400).json({ error: 'fullName is required.' });
    }

    const conn = getConnFromSession(req);
    const saveResult = await conn.metadata.delete('ValidationRule', [fullName]);
    const resultArr = Array.isArray(saveResult) ? saveResult : [saveResult];
    const failures = resultArr.filter((r) => !r.success);

    if (failures.length > 0) {
      const messages = failures.map((f) => f.errors?.message || f.message || 'Unknown error');
      return res.status(400).json({ error: messages.join('; ') });
    }

    res.json({ ok: true, results: resultArr });
  } catch (err) {
    console.error('Error deleting validation rule:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4 & 5. Deploy changes - accepts a list of { fullName, active } and pushes
// the new active/inactive state back to Salesforce via the Metadata API.
app.post('/api/rules/deploy', requireAuth, async (req, res) => {
  try {
    const { changes } = req.body; // [{ fullName: 'Account.Validation_Rule_1', active: true }, ...]
    if (!Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ error: 'No changes provided.' });
    }

    const conn = getConnFromSession(req);
    const fullNames = changes.map((c) => c.fullName);

    // Metadata API requires the FULL validation rule definition to update it,
    // so we read the existing rule(s) first, flip the "active" flag, then write back.
    const existing = await conn.metadata.read('ValidationRule', fullNames);
    const existingArr = Array.isArray(existing) ? existing : [existing];

    const updated = existingArr.map((rule) => {
      const change = changes.find((c) => c.fullName === rule.fullName);
      return {
        ...rule,
        active: change ? change.active : rule.active
      };
    });

    const saveResult = await conn.metadata.update('ValidationRule', updated);
    const resultsArr = Array.isArray(saveResult) ? saveResult : [saveResult];

    const failures = resultsArr.filter((r) => !r.success);
    if (failures.length > 0) {
      return res.status(400).json({ error: 'Some rules failed to deploy', failures });
    }

    res.json({ ok: true, results: resultsArr });
  } catch (err) {
    console.error('Error deploying changes:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SF Validation Toggle app running at http://localhost:${PORT}`);
});
