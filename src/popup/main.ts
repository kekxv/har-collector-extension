// src/popup/main.ts
import './style.css';

const toggleSwitch = document.getElementById('toggle-switch-input') as HTMLInputElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const requestCountEl = document.getElementById('request-count') as HTMLElement;
const saveHarButton = document.getElementById('save-har-button') as HTMLButtonElement;
const clearDataButton = document.getElementById('clear-data-button') as HTMLButtonElement;

function updateUI(isEnabled: boolean, count: number) {
    toggleSwitch.checked = isEnabled;
    statusText.textContent = isEnabled ? 'Sniffing Enabled' : 'Sniffing Disabled';
    requestCountEl.textContent = count.toString();
    const buttonsDisabled = !isEnabled || count === 0;
    saveHarButton.disabled = buttonsDisabled;
    clearDataButton.disabled = buttonsDisabled;
}

toggleSwitch.addEventListener('change', () => {
    const newState = toggleSwitch.checked;
    chrome.storage.local.set({isEnabled: newState});
    chrome.runtime.sendMessage({type: newState ? 'START_SNIFFING' : 'STOP_SNIFFING'});
    if (!newState) {
        updateUI(false, 0);
    }
});

saveHarButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({type: 'SAVE_HAR'});
});

clearDataButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({type: 'CLEAR_DATA'});
    updateUI(toggleSwitch.checked, 0);
});

chrome.storage.local.get(['isEnabled', 'requestCount'], (result) => {
    const isEnabled = !!result.isEnabled;
    const count = result.requestCount || 0;
    updateUI(isEnabled, count);
});

chrome.runtime.onMessage.addListener((message: any) => {
    if (message.type === 'UPDATE_COUNT') {
        if (toggleSwitch.checked) {
            updateUI(true, message.count);
        }
    }
});
