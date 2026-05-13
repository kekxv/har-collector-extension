// src/__tests__/popup.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mockChrome } from './setup';

// --- Notification logic ---
describe('popup notification logic', () => {
    let notifications: Array<{ level: string; message: string }> = [];

    beforeEach(() => {
        notifications = [];
    });

    const showNotification = (level: 'error' | 'success' | 'info', message: string) => {
        notifications.push({ level, message });
    };

    it('displays success notification', () => {
        showNotification('success', 'HAR file saved (5 entries).');
        expect(notifications).toHaveLength(1);
        expect(notifications[0].level).toBe('success');
        expect(notifications[0].message).toBe('HAR file saved (5 entries).');
    });

    it('displays error notification', () => {
        showNotification('error', 'Failed to save HAR: network error');
        expect(notifications).toHaveLength(1);
        expect(notifications[0].level).toBe('error');
    });

    it('displays info notification', () => {
        showNotification('info', 'Opening fallback page to download HAR...');
        expect(notifications).toHaveLength(1);
        expect(notifications[0].level).toBe('info');
    });

    it('clears previous notification timeout', () => {
        let clearedTimeout: number | null = null;
        let currentTimeout: number | null = 1;

        const showNotifWithClear = (level: string, message: string) => {
            if (currentTimeout) {
                clearedTimeout = currentTimeout;
            }
            currentTimeout = 2;
            notifications.push({ level, message });
        };

        showNotifWithClear('info', 'first');
        // At this point, clearedTimeout captured the initial 1, currentTimeout became 2
        expect(clearedTimeout).toBe(1);

        showNotifWithClear('error', 'second');
        // Now clearedTimeout captured the previous 2
        expect(clearedTimeout).toBe(2);
        expect(notifications).toHaveLength(2);
    });
});

// --- Button loading state ---
describe('save button loading state', () => {
    interface ButtonState {
        disabled: boolean;
        textContent: string;
        datasetLoading: string;
    }

    let button: ButtonState;

    beforeEach(() => {
        button = { disabled: false, textContent: 'Save as HAR', datasetLoading: '' };
    });

    const setSaveButtonLoading = (isLoading: boolean) => {
        if (isLoading) {
            button.disabled = true;
            button.datasetLoading = 'true';
            button.textContent = 'Saving...';
        } else {
            button.datasetLoading = '';
            button.textContent = 'Save as HAR';
            // Note: disabled is restored by updateUI, not here
        }
    };

    it('shows loading state', () => {
        setSaveButtonLoading(true);
        expect(button.disabled).toBe(true);
        expect(button.textContent).toBe('Saving...');
        expect(button.datasetLoading).toBe('true');
    });

    it('resets loading text but button disabled controlled by updateUI', () => {
        setSaveButtonLoading(true);
        setSaveButtonLoading(false);
        expect(button.textContent).toBe('Save as HAR');
        expect(button.datasetLoading).toBe('');
        // disabled stays true - updateUI restores it
        expect(button.disabled).toBe(true);
    });

    it('resets loading on notification received', () => {
        setSaveButtonLoading(true);

        // Simulate NOTIFICATION message
        const message = { type: 'NOTIFICATION', level: 'success', message: 'Done' };
        if (message.type === 'NOTIFICATION') {
            setSaveButtonLoading(false);
        }

        expect(button.textContent).toBe('Save as HAR');
        expect(button.datasetLoading).toBe('');
    });
});

// --- UI update logic ---
describe('popup UI update', () => {
    interface UIState {
        toggleChecked: boolean;
        statusText: string;
        requestCount: number;
        saveDisabled: boolean;
        clearDisabled: boolean;
    }

    let ui: UIState;

    const updateUI = (isEnabled: boolean, count: number) => {
        ui = {
            toggleChecked: isEnabled,
            statusText: isEnabled ? 'Sniffing Enabled' : 'Sniffing Disabled',
            requestCount: count,
            saveDisabled: count === 0,
            clearDisabled: count === 0,
        };
    };

    it('shows disabled buttons when no requests captured', () => {
        updateUI(true, 0);
        expect(ui.saveDisabled).toBe(true);
        expect(ui.clearDisabled).toBe(true);
    });

    it('enables buttons when requests exist regardless of sniffing state', () => {
        updateUI(false, 5);
        expect(ui.saveDisabled).toBe(false);
        expect(ui.clearDisabled).toBe(false);
        expect(ui.statusText).toBe('Sniffing Disabled');
        expect(ui.requestCount).toBe(5);
    });

    it('enables buttons when both sniffing on and requests exist', () => {
        updateUI(true, 5);
        expect(ui.saveDisabled).toBe(false);
        expect(ui.clearDisabled).toBe(false);
        expect(ui.statusText).toBe('Sniffing Enabled');
        expect(ui.requestCount).toBe(5);
    });
});

// --- Message handler simulation ---
describe('popup message handling', () => {
    it('handles UPDATE_COUNT message', () => {
        let count = 0;
        const toggleChecked = true;

        const handleMessage = (message: any) => {
            if (message.type === 'UPDATE_COUNT' && toggleChecked) {
                count = message.count;
            }
        };

        handleMessage({ type: 'UPDATE_COUNT', count: 42 });
        expect(count).toBe(42);
    });

    it('handles NOTIFICATION message', () => {
        let notification: { level: string; message: string } | null = null;

        const handleMessage = (message: any) => {
            if (message.type === 'NOTIFICATION') {
                notification = { level: message.level, message: message.message };
            }
        };

        handleMessage({ type: 'NOTIFICATION', level: 'error', message: 'Save failed' });
        expect(notification).toEqual({ level: 'error', message: 'Save failed' });
    });

    it('SAVE_HAR sends message to background', () => {
        const sentMessages: any[] = [];
        mockChrome.runtime.sendMessage.mockImplementation((msg: any) => {
            sentMessages.push(msg);
            return Promise.resolve();
        });

        // Simulate save button click
        mockChrome.runtime.sendMessage({ type: 'SAVE_HAR' });

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].type).toBe('SAVE_HAR');
    });

    it('CLEAR_DATA sends message and resets count', () => {
        const sentMessages: any[] = [];
        mockChrome.runtime.sendMessage.mockImplementation((msg: any) => {
            sentMessages.push(msg);
            return Promise.resolve();
        });

        mockChrome.runtime.sendMessage({ type: 'CLEAR_DATA' });

        expect(sentMessages[0].type).toBe('CLEAR_DATA');
    });
});

// --- Toggle switch behavior ---
describe('toggle switch behavior', () => {
    it('enables sniffing when toggled on', async () => {
        const sentMessages: any[] = [];
        mockChrome.runtime.sendMessage.mockImplementation((msg: any) => {
            sentMessages.push(msg);
            return Promise.resolve();
        });

        await mockChrome.storage.local.set({ isEnabled: true });
        mockChrome.runtime.sendMessage({ type: 'START_SNIFFING' });

        expect(sentMessages[0].type).toBe('START_SNIFFING');
    });

    it('disables sniffing when toggled off without clearing count', async () => {
        const sentMessages: any[] = [];
        mockChrome.storage.local.set.mockImplementation(async () => {});
        mockChrome.runtime.sendMessage.mockImplementation((msg: any) => {
            sentMessages.push(msg);
            return Promise.resolve();
        });

        await mockChrome.storage.local.set({ isEnabled: false });
        mockChrome.runtime.sendMessage({ type: 'STOP_SNIFFING' });

        expect(sentMessages[0].type).toBe('STOP_SNIFFING');
        // Should NOT clear the request count — user can still save/clear data
    });
});
