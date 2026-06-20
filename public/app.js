// ---- State ----
let rules = [];           // [{id, name, fullName, active, errorMessage}]
let pendingChanges = {};  // fullName -> newActiveState (only when different from loaded state)

const rulesBody = document.getElementById('rulesBody');
const rulesTable = document.getElementById('rulesTable');
const objectHeaderRow = document.getElementById('objectHeaderRow');
const emptyMsg = document.getElementById('emptyMsg');
const statusBox = document.getElementById('statusBox');
const deployBtn = document.getElementById('deployBtn');
const rollbackBtn = document.getElementById('rollbackBtn');
const enableAllBtn = document.getElementById('enableAllBtn');
const disableAllBtn = document.getElementById('disableAllBtn');
const getRulesBtn = document.getElementById('getRulesBtn');
const logoutBtn = document.getElementById('logoutBtn');
const whoamiBox = document.getElementById('whoami');

const newRuleBtn = document.getElementById('newRuleBtn');
const newRuleForm = document.getElementById('newRuleForm');
const createRuleBtn = document.getElementById('createRuleBtn');
const cancelRuleBtn = document.getElementById('cancelRuleBtn');
const ruleNameInput = document.getElementById('ruleNameInput');
const formulaInput = document.getElementById('formulaInput');
const errorMsgInput = document.getElementById('errorMsgInput');
const activeInput = document.getElementById('activeInput');

function showStatus(message, type = 'info') {
  statusBox.textContent = message;
  statusBox.className = `status-box ${type}`;
  statusBox.classList.remove('hidden');
}

function hideStatus() {
  statusBox.classList.add('hidden');
}

function updateDeployButtonState() {
  const hasChanges = Object.keys(pendingChanges).length > 0;
  deployBtn.disabled = !hasChanges;
  rollbackBtn.disabled = !hasChanges;
}

function renderRules() {
  if (rules.length === 0) {
    rulesTable.classList.add('hidden');
    objectHeaderRow.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    return;
  }

  rulesTable.classList.remove('hidden');
  objectHeaderRow.classList.remove('hidden');
  emptyMsg.classList.add('hidden');

  rulesBody.innerHTML = '';
  rules.forEach((rule) => {
    const currentState =
      rule.fullName in pendingChanges ? pendingChanges[rule.fullName] : rule.active;
    const isDirty = rule.fullName in pendingChanges && pendingChanges[rule.fullName] !== rule.active;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${rule.name}${isDirty ? '<span class="dirty-badge">UNSAVED</span>' : ''}</td>
      <td>${rule.errorMessage || ''}</td>
      <td>
        <div class="toggle-segment" data-fullname="${rule.fullName}">
          <div class="seg on ${currentState ? 'active' : ''}" data-value="true">ON</div>
          <div class="seg off ${!currentState ? 'active' : ''}" data-value="false">OFF</div>
        </div>
      </td>
      <td><button class="btn btn-delete" data-delete="${rule.fullName}">Delete</button></td>
    `;
    rulesBody.appendChild(tr);
  });

  // Wire up delete buttons
  rulesBody.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteRule(btn.dataset.delete));
  });

  // Wire up segmented toggle clicks
  rulesBody.querySelectorAll('.toggle-segment').forEach((segGroup) => {
    const fullName = segGroup.dataset.fullname;
    segGroup.querySelectorAll('.seg').forEach((seg) => {
      seg.addEventListener('click', () => {
        const rule = rules.find((r) => r.fullName === fullName);
        const newState = seg.dataset.value === 'true';

        if (newState === rule.active) {
          delete pendingChanges[fullName];
        } else {
          pendingChanges[fullName] = newState;
        }
        renderRules();
        updateDeployButtonState();
      });
    });
  });
}

async function loadWhoAmI() {
  const res = await fetch('/api/whoami');
  const data = await res.json();
  if (!data.loggedIn) {
    window.location.href = '/';
    return;
  }
  whoamiBox.textContent = `Logged in as ${data.username} (Org: ${data.organizationId})`;
}

async function getValidationRules() {
  hideStatus();
  getRulesBtn.disabled = true;
  showStatus('Querying metadata… building list of validation rules on Account.', 'info');
  try {
    const res = await fetch('/api/rules');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load validation rules');

    rules = data.rules;
    pendingChanges = {};
    updateDeployButtonState();
    renderRules();

    if (rules.length === 0) {
      showStatus('No validation rules found on the Account object.', 'info');
    } else {
      showStatus(`Loaded ${rules.length} validation rule(s) from Account.`, 'success');
    }
  } catch (err) {
    showStatus('Error: ' + err.message, 'error');
  } finally {
    getRulesBtn.disabled = false;
  }
}

function enableAll() {
  rules.forEach((r) => {
    if (!r.active) pendingChanges[r.fullName] = true;
    else delete pendingChanges[r.fullName];
  });
  renderRules();
  updateDeployButtonState();
}

function disableAll() {
  rules.forEach((r) => {
    if (r.active) pendingChanges[r.fullName] = false;
    else delete pendingChanges[r.fullName];
  });
  renderRules();
  updateDeployButtonState();
}

function showNewRuleForm() {
  newRuleForm.classList.remove('hidden');
  ruleNameInput.value = '';
  formulaInput.value = '';
  errorMsgInput.value = '';
  activeInput.checked = true;
  ruleNameInput.focus();
}

function hideNewRuleForm() {
  newRuleForm.classList.add('hidden');
}

async function createRule() {
  const ruleName = ruleNameInput.value.trim();
  const errorConditionFormula = formulaInput.value.trim();
  const errorMessage = errorMsgInput.value.trim();
  const active = activeInput.checked;

  if (!ruleName || !errorConditionFormula || !errorMessage) {
    showStatus('Please fill in Rule Name, Formula, and Error Message.', 'error');
    return;
  }

  createRuleBtn.disabled = true;
  showStatus('Creating validation rule on Account…', 'info');

  try {
    const res = await fetch('/api/rules/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ruleName, errorConditionFormula, errorMessage, active })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create rule');

    showStatus(`Created "${ruleName}" successfully.`, 'success');
    hideNewRuleForm();
    await getValidationRules();
  } catch (err) {
    showStatus('Error creating rule: ' + err.message, 'error');
  } finally {
    createRuleBtn.disabled = false;
  }
}

async function deleteRule(fullName) {
  const ruleLabel = fullName.split('.').slice(1).join('.');
  if (!confirm(`Delete validation rule "${ruleLabel}"? This cannot be undone.`)) return;

  showStatus(`Deleting "${ruleLabel}"…`, 'info');
  try {
    const res = await fetch('/api/rules/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete rule');

    delete pendingChanges[fullName];
    showStatus(`Deleted "${ruleLabel}".`, 'success');
    await getValidationRules();
  } catch (err) {
    showStatus('Error deleting rule: ' + err.message, 'error');
  }
}

function rollbackToOriginal() {
  pendingChanges = {};
  renderRules();
  updateDeployButtonState();
  showStatus('Reverted all unsaved changes back to the original state.', 'info');
}

async function deployChanges() {
  const changes = Object.entries(pendingChanges).map(([fullName, active]) => ({
    fullName,
    active
  }));

  if (changes.length === 0) return;

  deployBtn.disabled = true;
  showStatus(`Deploying ${changes.length} change(s) to Salesforce…`, 'info');

  try {
    const res = await fetch('/api/rules/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Deploy failed');

    showStatus('Deployment successful! Refreshing rule list…', 'success');
    pendingChanges = {};
    await getValidationRules();
  } catch (err) {
    showStatus('Deploy error: ' + err.message, 'error');
    deployBtn.disabled = false;
  }
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/';
}

getRulesBtn.addEventListener('click', getValidationRules);
newRuleBtn.addEventListener('click', showNewRuleForm);
cancelRuleBtn.addEventListener('click', hideNewRuleForm);
createRuleBtn.addEventListener('click', createRule);
enableAllBtn.addEventListener('click', enableAll);
disableAllBtn.addEventListener('click', disableAll);
rollbackBtn.addEventListener('click', rollbackToOriginal);
deployBtn.addEventListener('click', deployChanges);
logoutBtn.addEventListener('click', logout);

loadWhoAmI();
