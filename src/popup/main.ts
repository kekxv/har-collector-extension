// src/popup/main.ts
import './style.css';

const toggleSwitch = document.getElementById('toggle-switch-input') as HTMLInputElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const requestCountEl = document.getElementById('request-count') as HTMLElement;
const openManagementButton = document.getElementById('open-management-button') as HTMLButtonElement;
const clearDataButton = document.getElementById('clear-data-button') as HTMLButtonElement;
const appTitle = document.getElementById('app-title') as HTMLHeadingElement;
const capturedLabel = document.getElementById('captured-label') as HTMLSpanElement;
const notificationEl = document.getElementById('notification') as HTMLDivElement;
const notificationText = document.getElementById('notification-text') as HTMLSpanElement;

// i18n helper
function msg(key: string, substitutions?: string | string[]): string {
    return chrome.i18n.getMessage(key, substitutions);
}

// Initialize static i18n strings
appTitle.textContent = msg('popupTitle') || 'HarCollector';
capturedLabel.textContent = msg('capturedRequests') || 'Captured Requests';
openManagementButton.textContent = msg('openManagement') || 'Open Manager';
clearDataButton.textContent = msg('clearDataButton') || 'Clear Data';

let notificationTimeout: number | null = null;

function showNotification(level: 'error' | 'success' | 'info', message: string) {
    if (notificationTimeout) {
        clearTimeout(notificationTimeout);
    }
    notificationEl.className = `notification notification-${level}`;
    notificationText.textContent = message;
    notificationEl.style.display = 'flex';
    notificationTimeout = window.setTimeout(() => {
        notificationEl.style.display = 'none';
    }, 4000);
}

function updateUI(isEnabled: boolean, count: number) {
    toggleSwitch.checked = isEnabled;
    statusText.textContent = isEnabled
        ? (msg('sniffingEnabled') || 'Sniffing Enabled')
        : (msg('sniffingDisabled') || 'Sniffing Disabled');
    requestCountEl.textContent = count.toString();
    const buttonsDisabled = count === 0;
    openManagementButton.disabled = buttonsDisabled;
    clearDataButton.disabled = buttonsDisabled;
}

toggleSwitch.addEventListener('change', () => {
    const newState = toggleSwitch.checked;
    chrome.storage.local.set({isEnabled: newState});
    chrome.runtime.sendMessage({type: newState ? 'START_SNIFFING' : 'STOP_SNIFFING'});
});

openManagementButton.addEventListener('click', () => {
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
        updateUI(toggleSwitch.checked, message.count);
    } else if (message.type === 'NOTIFICATION') {
        showNotification(message.level, message.message);
    }
});
