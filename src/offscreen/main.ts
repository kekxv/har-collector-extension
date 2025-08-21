// src/offscreen/main.ts

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.target === 'offscreen' && message.type === 'create-blob-url') {

        // **最终修复**: 使用 'application/octet-stream' MIME 类型。
        // 这会强制浏览器使用我们提供的文件名和后缀，而不是自己猜测。
        const blob = new Blob([message.data], {type: 'application/octet-stream'});

        const url = URL.createObjectURL(blob);
        sendResponse({url: url});

        // 返回 true 表明我们将异步地发送响应
        return true;
    } else if (message.target === 'offscreen_popup' && message.type === 'DOWNLOAD_HAR') {
        const { harString, safeFilename } = message;

        const blob = new Blob([harString], { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);

        chrome.downloads.download({
            url: blobUrl,
            filename: safeFilename,
            saveAs: true,
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("Download failed in popup:", chrome.runtime.lastError.message);
            } else {
                console.log("Download initiated from popup with ID:", downloadId);
            }
            // Revoke the blob URL after download is initiated
            URL.revokeObjectURL(blobUrl);

            // Close the popup window after download is initiated
            setTimeout(() => {
                window.close();
            }, 1000); // Close after 1 second
        });
        // No return true here, as no async response is expected back to the sender
    }
});
