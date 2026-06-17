const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const readline = require('readline/promises');

const config = {
  baseUrl: process.env.KNOI_BASE_URL || 'https://knoi.tech',
  headless: false,
  loginPath: process.env.KNOI_LOGIN_PATH || '/login',
  explorePath: process.env.KNOI_EXPLORE_PATH || '/explore',
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH || '',
  chromeUserDataDir:
    process.env.CHROME_USER_DATA_DIR || path.join(process.cwd(), '.knoi-chrome-profile'),
  chromeProfileName: process.env.CHROME_PROFILE_NAME || 'Default',
  remoteDebuggingPort: Number(process.env.CHROME_CDP_PORT || 9222),
  outputPrefix: process.env.OUTPUT_PREFIX || `knoi-smart-questions-${new Date().toISOString().slice(0, 10)}`,
  boardName: process.env.KNOI_BOARD || '',
  className: process.env.KNOI_CLASS || '',
  bookName: process.env.KNOI_BOOK || '',
  questionSelector: process.env.KNOI_QUESTION_SELECTOR || '.question-item, [data-testid="question-item"], .smart-question-item',
  answerSelector: process.env.KNOI_ANSWER_SELECTOR || '.response-area, [data-testid="answer"], .answer, .answer-content',
};

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true';
    parsed[key] = value;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
config.boardName = args.board || config.boardName;
config.className = args.class || config.className;
config.bookName = args.book || config.bookName;

function ensureAbsoluteUrl(baseUrl, maybePath) {
  if (!maybePath) return baseUrl;
  if (/^https?:\/\//i.test(maybePath)) return maybePath;
  return new URL(maybePath, baseUrl).toString();
}

function resolveChromeExecutablePath() {
  if (config.chromeExecutablePath) {
    return config.chromeExecutablePath;
  }

  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
  }
  return null;
}

async function clickFirstVisible(page, selectors, description) {
  const locator = await firstVisibleLocator(page, selectors);
  if (!locator) {
    throw new Error(`Could not find ${description}`);
  }
  await locator.click();
  return locator;
}

async function clickText(page, text, description) {
  const escaped = text.replace(/"/g, '\\"');
  const locator =
    (await firstVisibleLocator(page, [
      `text="${escaped}"`,
      `a:has-text("${escaped}")`,
      `button:has-text("${escaped}")`,
      `div:has-text("${escaped}")`,
      `span:has-text("${escaped}")`,
    ])) || page.getByText(text, { exact: false }).first();

  if (!(await locator.count().catch(() => 0))) {
    throw new Error(`Could not find ${description}`);
  }
  await locator.click();
  return locator;
}

async function clickAny(page, selectors, description) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count().catch(() => 0)) {
        if (await locator.isVisible().catch(() => false)) {
          await locator.click();
          return locator;
        }
      }
    } catch (error) {
      // Try the next selector.
    }
  }

  throw new Error(`Could not find ${description}`);
}

async function waitForEnter(message) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await input.question(`${message}\nPress Enter after you finish signing in...`);
  } finally {
    input.close();
  }
}

async function ensureOn(page, targetUrl) {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function chooseCurrentContext(page) {
  await clickFirstVisible(
    page,
    ['text=Global', 'text=Global Library', 'a:has-text("Global")', 'button:has-text("Global")'],
    'Global section'
  );

  await clickFirstVisible(
    page,
    ['text=Document', 'a:has-text("Document")', 'button:has-text("Document")'],
    'Document section'
  );

  if (config.boardName) {
    await clickText(page, config.boardName, `board "${config.boardName}"`);
  }

  if (config.className) {
    await clickText(page, config.className, `class/book "${config.className}"`);
  }

  if (config.bookName) {
    await clickText(page, config.bookName, `book "${config.bookName}"`);
  }
}

async function openDocumentAnalysis(page) {
  await clickFirstVisible(
    page,
    ['text=Document Analysis', 'text=Analysis', 'a:has-text("Analysis")', 'button:has-text("Analysis")'],
    'document analysis page'
  );
}

async function openSmartQuestionPanel(page) {
  await clickAny(
    page,
    [
      'text=Smart Questions',
      'text=Smart Question',
      'text=Smart question',
      'button:has-text("Smart Questions")',
      'button:has-text("Smart Question")',
      'a:has-text("Smart Questions")',
      'a:has-text("Smart Question")',
      '[data-testid*="smart"]',
      '[aria-label*="smart" i]',
    ],
    'Smart Questions panel'
  );
}

async function extractQuestions(page) {
  const questionElements = page.locator(config.questionSelector);
  const count = await questionElements.count();

  if (!count) {
    throw new Error(`No questions found with selector: ${config.questionSelector}`);
  }

  const questions = [];
  for (let index = 0; index < count; index += 1) {
    const text = (await questionElements.nth(index).innerText().catch(() => '')).trim();
    if (text) {
      questions.push({
        index: index + 1,
        locatorIndex: index,
        text,
      });
    }
  }

  return questions;
}

async function captureAnswerForQuestion(page, questionLocator) {
  await questionLocator.click();

  const answerLocator = page.locator(config.answerSelector).first();
  await answerLocator.waitFor({ state: 'visible', timeout: 30000 });

  return (await answerLocator.innerText().catch(() => '')).trim();
}

function toCsv(rows) {
  const headers = ['sl', 'board', 'class', 'book', 'question', 'answer'];
  const escapeCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.sl,
      row.board,
      row.className,
      row.book,
      row.question,
      row.answer,
    ].map(escapeCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function exportResults(rows) {
  const jsonPath = path.resolve(`${config.outputPrefix}.json`);
  const csvPath = path.resolve(`${config.outputPrefix}.csv`);

  await fsPromises.writeFile(jsonPath, JSON.stringify(rows, null, 2), 'utf8');
  await fsPromises.writeFile(csvPath, toCsv(rows), 'utf8');

  return { jsonPath, csvPath };
}

async function dumpDebug(page, label) {
  const safeLabel = String(label).replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  const screenshotPath = path.resolve(`knoi-debug-${safeLabel}.png`);
  const htmlPath = path.resolve(`knoi-debug-${safeLabel}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fsPromises.writeFile(htmlPath, await page.content(), 'utf8').catch(() => {});

  console.log(`Debug saved: ${screenshotPath}`);
  console.log(`Debug saved: ${htmlPath}`);
}

async function createBrowserSession() {
  const cdpUrl = process.env.CHROME_CDP_URL;
  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] || (await browser.newContext());
    return { browser, context, ownsBrowser: false };
  }

  const chromeExecutablePath = resolveChromeExecutablePath();
  if (!chromeExecutablePath) {
    throw new Error('Could not find a Chrome executable. Set CHROME_EXECUTABLE_PATH.');
  }

  await fsPromises.mkdir(config.chromeUserDataDir, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${config.remoteDebuggingPort}`,
    `--user-data-dir=${config.chromeUserDataDir}`,
    `--profile-directory=${config.chromeProfileName}`,
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    'about:blank',
  ];

  const chromeProcess = spawn(chromeExecutablePath, chromeArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });

  chromeProcess.unref();

  const versionUrl = `http://127.0.0.1:${config.remoteDebuggingPort}/json/version`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(versionUrl);
      if (response.ok) {
        break;
      }
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.remoteDebuggingPort}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  return { browser, context, ownsBrowser: false };
}

async function run() {
  const session = await createBrowserSession();
  const existingPages = session.context.pages();
  const page = existingPages[0] || (await session.context.newPage());
  await page.bringToFront().catch(() => {});
  try {
    await ensureOn(page, ensureAbsoluteUrl(config.baseUrl, config.loginPath));
    await waitForEnter('Sign in manually in the opened browser window');

    await ensureOn(page, ensureAbsoluteUrl(config.baseUrl, config.explorePath));
    await clickFirstVisible(page, ['text=Global Library', 'a:has-text("Global Library")', 'button:has-text("Global Library")', 'text=Library'], 'Global Library');
    await chooseCurrentContext(page);
    await openDocumentAnalysis(page);
    await page.waitForTimeout(2000);
    try {
      await openSmartQuestionPanel(page);
    } catch (error) {
      console.log(`Panel lookup failed at URL: ${page.url()}`);
      console.log(`Page title: ${await page.title().catch(() => '')}`);
      await dumpDebug(page, 'smart-question-panel-failure');
      throw error;
    }

    const questions = await extractQuestions(page);
    const results = [];

    for (const question of questions) {
      const questionLocator = page.locator(config.questionSelector).nth(question.locatorIndex);
      const answer = await captureAnswerForQuestion(page, questionLocator);
      const row = {
        sl: question.index,
        board: config.boardName,
        className: config.className,
        book: config.bookName,
        question: question.text,
        answer,
      };
      results.push(row);
      console.log(JSON.stringify(row, null, 2));
    }

    const output = await exportResults(results);
    console.log(`Saved ${results.length} rows to ${output.csvPath} and ${output.jsonPath}`);
  } finally {
    if (session.ownsBrowser) {
      await session.browser.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { run };
