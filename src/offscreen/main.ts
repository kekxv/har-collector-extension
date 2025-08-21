// src/offscreen/main.ts

chrome.runtime.onMessage.addListener((message) => {
    if (message.target === 'offscreen' && message.type === 'download-har') {
        const { data, filename } = message;

        // 使用 'application/json' 类型，因为 HAR 文件是 JSON 格式
        const blob = new Blob([data], {type: 'application/json'});
        const url = URL.createObjectURL(blob);

        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true,
        }, () => {
            // 下载开始后，无论成功与否，都立即释放 URL 对象以节省内存
            URL.revokeObjectURL(url);
        });

        // 这里不需要返回 true，因为我们没有使用 sendResponse
    }
});