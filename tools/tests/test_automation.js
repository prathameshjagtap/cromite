// Example: drive Cromite on Android via WebDriverIO + Appium with the
// "headless / show-on-demand" automation mode (Add-headless-automation-mode.patch).
//
// Demonstrates the requested capabilities:
//   - open a new tab
//   - go to a URL
//   - type text into a text box on a webpage
//   - click a button on a webpage
//   - hide the webpage while automated actions happen
//   - show the webpage to the user on demand
//
// Prerequisites:
//   - A Cromite build that includes Add-cromite-test-support.patch and
//     Add-headless-automation-mode.patch, installed on an AVD/device.
//   - Appium 2 (UiAutomator2 driver) listening on 127.0.0.1:4723.
//   - `npm install` in tools/tests (webdriverio).
//
// Run:  node tools/tests/test_automation.js
//
// Notes:
//   - window.cromite.* is only exposed on chrome://version (same gate as the
//     other test APIs). setContentVisible/isContentVisible act on the active
//     tab's WebContents container view, and the overlay persists across
//     same-tab navigations, so the pattern is: open chrome://version, hide,
//     navigate the tab to the target URL, automate while hidden, then reveal.

const { remote } = require('webdriverio');

const PKG = 'org.cromite.cromite';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let driver;

const ua = sel => driver.$('-android uiautomator:' + sel);
const tapText = async text => (await ua('new UiSelector().text("' + text + '")')).click();
const tapId = async id => (await ua('new UiSelector().resourceId("' + PKG + ':id/' + id + '")')).click();

// Type a URL into the omnibox and commit it (works for chrome:// and http(s)).
async function gotoUrl(url) {
  const bar = await ua('new UiSelector().resourceId("' + PKG + ':id/url_bar")');
  await bar.click();
  await bar.addValue(url);
  await driver.executeScript('mobile: pressKey', [{ keycode: 66 }]); // ENTER
  await sleep(1500);
}

async function inWebView(fn) {
  await driver.switchContext('WEBVIEW_' + PKG);
  try { return await fn(); }
  finally { await driver.switchContext('NATIVE_APP'); }
}

async function main() {
  driver = await remote({
    capabilities: {
      platformName: 'android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': PKG,
      'appium:appActivity': 'com.google.android.apps.chrome.Main',
      'appium:chromeOptions': {
        androidDeviceSocket: 'chrome_devtools_remote',
        androidExecName: 'unusedbutimportant',
      },
    },
    hostname: '127.0.0.1',
    port: 4723,
  });

  try {
    // First-run terms, if shown.
    const terms = await driver.findElement('id', PKG + ':id/terms_accept');
    if (!terms.error) {
      await tapId('terms_accept');
      await tapId('button_primary');
    }

    // Enable the two flags in Developer options, then restart.
    await tapId('menu_button');
    await sleep(800);
    await tapId('preferences_id');
    await sleep(800);
    await tapText('Developer options');
    await tapText('Enable support for cromite test');
    await tapText('Headless automation mode');
    await tapId('snackbar_button'); // "Relaunch"
    await sleep(3000);
    for (let i = 0; i < 10 && (await driver.findElement('id', PKG + ':id/url_bar')).error; i++) {
      await sleep(1000);
    }

    // 1) Open a NEW TAB.
    await tapId('menu_button');
    await sleep(600);
    await tapId('new_tab_menu_id');
    await sleep(800);

    // Open chrome://version so window.cromite.* is available, then HIDE.
    await gotoUrl('chrome://version');
    await inWebView(async () => {
      await driver.executeScript('await window.cromite.setContentVisible(false)', []);
      const hidden = await driver.executeScript('return await window.cromite.isContentVisible();', []);
      console.log('content visible after hide =', hidden); // expect false
    });

    // 2) GO TO A URL (same tab; the overlay persists so this stays hidden).
    await gotoUrl('https://duckduckgo.com/');
    await sleep(1500);

    // 3) TYPE TEXT into a text box, and 4) CLICK a button — all while HIDDEN.
    await inWebView(async () => {
      await driver.executeScript(`
        const box = document.querySelector('input[name="q"]');
        box.focus(); box.value = 'cromite browser';
        box.dispatchEvent(new Event('input', { bubbles: true }));
      `, []);
      await driver.executeScript(`
        const btn = document.querySelector('button[type="submit"], input[type="submit"]');
        if (btn) btn.click(); else document.querySelector('form').submit();
      `, []);
    });
    await sleep(2500);

    // 5/6) SHOW the result to the user on demand.
    await gotoUrl('chrome://version'); // re-open the gated page in the same tab
    await inWebView(async () => {
      await driver.executeScript('await window.cromite.setContentVisible(true)', []);
      const visible = await driver.executeScript('return await window.cromite.isContentVisible();', []);
      console.log('content visible after show =', visible); // expect true
    });

    console.log('Done.');
  } finally {
    await driver.deleteSession();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
