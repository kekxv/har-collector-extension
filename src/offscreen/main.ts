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
    }
});
