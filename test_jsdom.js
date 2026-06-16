const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const html = fs.readFileSync('c:/Users/LENOVO/Desktop/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/restaurant.html', 'utf8');

const virtualConsole = new jsdom.VirtualConsole();
virtualConsole.on("jsdomError", (error) => {
  console.error(error.stack, error.detail);
});
virtualConsole.on("error", (msg) => {
  console.error(msg);
});
virtualConsole.on("warn", (msg) => {
  console.warn(msg);
});
virtualConsole.on("info", (msg) => {
  console.info(msg);
});
virtualConsole.on("log", (msg) => {
  console.log(msg);
});

const dom = new JSDOM(html, { 
    runScripts: "dangerously", 
    virtualConsole,
    url: "http://localhost/"
});

setTimeout(() => {
    // try to click a button
    const headers = dom.window.document.querySelectorAll('.tree-header');
    if (headers.length > 0) {
        console.log("Found headers:", headers.length);
        const group = headers[1].closest('.tree-group');
        console.log("Before click group open:", group.classList.contains('open'));
        headers[1].click();
        console.log("After click group open:", group.classList.contains('open'));
    } else {
        console.log("No headers found!");
    }
}, 500);
