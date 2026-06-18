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
  questionCsvPath:
    process.env.QUESTION_CSV_PATH || path.join(process.cwd(), 'knoi-smart-questions-2026-06-17.csv'),
  questionStartLine: Number(process.env.QUESTION_START_LINE || 14),
  questionSource: process.env.KNOI_QUESTION_SOURCE || 'live',
  dryRun: false,
  imageOutputDir: process.env.IMAGE_OUTPUT_DIR || path.join(process.cwd(), 'knoi-smart-questions-images'),
  questionDelayMs: Number(process.env.QUESTION_DELAY_MS || 1500),
  questionLoadTimeoutMs: Number(process.env.QUESTION_LOAD_TIMEOUT_MS || 15000),
  answerWaitTimeoutMs: Number(process.env.KNOI_ANSWER_WAIT_TIMEOUT_MS || 300000),
  keepAwake: String(process.env.KNOI_KEEP_AWAKE || '').toLowerCase() !== 'false',
  resumeFromCheckpoint: String(process.env.KNOI_RESUME || '').toLowerCase() !== 'false',
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
config.questionCsvPath = args.questions || config.questionCsvPath;
config.questionStartLine = Number(args['start-line'] || args.startLine || config.questionStartLine);
config.questionSource = String(args.source || args.questionSource || config.questionSource || '')
  .trim()
  .toLowerCase();
if (!config.questionSource || !['live', 'file'].includes(config.questionSource)) {
  config.questionSource = config.questionCsvPath && args.questions ? 'file' : 'live';
}
config.dryRun = String(args['dry-run'] || args.dryRun || process.env.DRY_RUN || '').toLowerCase() === 'true'
  || String(args['dry-run'] || args.dryRun || process.env.DRY_RUN || '') === '1';
config.imageOutputDir = args['image-dir'] || config.imageOutputDir;
config.keepAwake = String(args['keep-awake'] ?? args.keepAwake ?? process.env.KNOI_KEEP_AWAKE ?? config.keepAwake).toLowerCase() !== 'false'
  && String(args['keep-awake'] ?? args.keepAwake ?? process.env.KNOI_KEEP_AWAKE ?? config.keepAwake).toLowerCase() !== '0';
config.resumeFromCheckpoint = String(args.resume ?? process.env.KNOI_RESUME ?? config.resumeFromCheckpoint).toLowerCase() !== 'false'
  && String(args.resume ?? process.env.KNOI_RESUME ?? config.resumeFromCheckpoint).toLowerCase() !== '0';

let keepAwakeProcess = null;

function ensureAbsoluteUrl(baseUrl, maybePath) {
  if (!maybePath) return baseUrl;
  if (/^https?:\/\//i.test(maybePath)) return maybePath;
  return new URL(maybePath, baseUrl).toString();
}

function normalizeLabel(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function sanitizeFileStem(value, fallback = 'knoi-smart-questions') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || fallback).slice(0, 120);
}

function normalizeExploringLabel(value) {
  return String(value || '')
    .replace(/^exploring:\s*/i, '')
    .replace(/_/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function toReadableFileStem(value, fallback = 'knoi-smart-questions') {
  const normalized = normalizeExploringLabel(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitizeFileStem(normalized.toLowerCase(), fallback);
}

function labelCandidates(value) {
  const normalized = normalizeLabel(value);
  const candidates = new Set([value, normalized]);

  if (normalized.includes('gujarati') || normalized.includes('gujarti') || normalized.includes('gujarat')) {
    candidates.add('Gujarat State Board');
  }

  if (normalized.includes('class 7') || normalized.includes('std 7') || normalized === '7') {
    candidates.add('Class 7');
    candidates.add('Std 7');
  }

  return [...candidates].filter(Boolean);
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (character === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  cells.push(current);
  return cells;
}

function parseCsvText(text, startLine = 2) {
  const normalizedText = String(text || '').replace(/^\uFEFF/, '');
  const lines = normalizedText.split(/\r?\n/);
  const rows = [];

  for (let lineNumber = Math.max(2, Number(startLine) || 2); lineNumber <= lines.length; lineNumber += 1) {
    const rawLine = lines[lineNumber - 1];
    if (!rawLine || !rawLine.trim()) continue;

    const cells = splitCsvLine(rawLine);
    if (cells.length < 5) continue;
    const questionText = (cells[4] || '').trim();
    if (!questionText || /^refresh$/i.test(questionText)) continue;

    rows.push({
      sourceLine: lineNumber,
      sl: (cells[0] || '').trim(),
      board: (cells[1] || '').trim(),
      className: (cells[2] || '').trim(),
      book: (cells[3] || '').trim(),
      question: questionText,
      answer: (cells[5] || '').trim(),
    });
  }

  return rows;
}

async function loadQuestionsFromCsv(filePath, startLine) {
  if (fs.existsSync(filePath)) {
    const csvText = await fsPromises.readFile(filePath, 'utf8');
    const rows = parseCsvText(csvText, startLine);
    return rows.filter((row) => row.question);
  }

  const jsonPath = filePath.replace(/\.csv$/i, '.json');
  if (fs.existsSync(jsonPath)) {
    const jsonText = await fsPromises.readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(jsonText);
    const minSl = Math.max(1, Number(startLine) - 1);
    return parsed
      .map((row, index) => ({
        sourceLine: Number(row.sl) ? Number(row.sl) + 1 : index + 2,
        sl: String(row.sl ?? ''),
        board: String(row.board ?? ''),
        className: String(row.className ?? ''),
        book: String(row.book ?? ''),
        question: String(row.question ?? '').trim(),
        answer: String(row.answer ?? ''),
      }))
      .filter((row) => row.question && !/^refresh$/i.test(row.question) && Number(row.sl) >= minSl);
  }

  throw new Error(`Could not find ${filePath} or ${jsonPath}`);
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

function getCheckpointPath() {
  return path.resolve(`${config.outputPrefix}.checkpoint.json`);
}

async function loadRunCheckpoint(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) {
    return null;
  }

  try {
    const raw = await fsPromises.readFile(checkpointPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.log(`Ignoring unreadable checkpoint at ${checkpointPath}: ${error.message}`);
    return null;
  }
}

async function saveRunCheckpoint(checkpointPath, payload) {
  const tempPath = `${checkpointPath}.tmp`;
  await fsPromises.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  await fsPromises.rename(tempPath, checkpointPath);
}

async function clearRunCheckpoint(checkpointPath) {
  await fsPromises.unlink(checkpointPath).catch(() => {});
}

function isRecoverableSessionError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return [
    'target closed',
    'browser has been closed',
    'page has been closed',
    'session closed',
    'browser disconnected',
    'crashed',
    'page closed',
    'execution context was destroyed',
    'navigation failed because page was closed',
  ].some((needle) => message.includes(needle));
}

function isGenericUnavailableAnswer(text) {
  const normalized = normalizeLabel(text);
  return [
    'this information is not available in the document.',
    'this information is not available in the document',
    'information is not available in the document',
    'not available in the document',
  ].some((phrase) => normalized.includes(phrase));
}

function startKeepAwake() {
  if (!config.keepAwake || process.platform !== 'win32' || keepAwakeProcess) {
    return;
  }

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Win32 -Name PowerState -MemberDefinition @'
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
'@
$flags = 0x80000003
while ($true) {
  [Win32.PowerState]::SetThreadExecutionState($flags) | Out-Null
  Start-Sleep -Seconds 30
}
`;

  keepAwakeProcess = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script],
    { stdio: 'ignore', windowsHide: true }
  );
  keepAwakeProcess.unref();
}

async function stopKeepAwake() {
  if (!keepAwakeProcess) {
    return;
  }

  keepAwakeProcess.kill();
  keepAwakeProcess = null;
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

async function getQuestionInputLocator(page) {
  const selectors = [
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    'input[placeholder*="Ask" i]',
    'textarea[placeholder*="Ask" i]',
    'input[aria-label*="Ask" i]',
    'textarea[aria-label*="Ask" i]',
    '[placeholder*="Ask" i]',
    '[aria-label*="Ask" i]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
  }

  throw new Error('Could not find the smart question input box');
}

async function clickCard(page, label, description) {
  const candidates = labelCandidates(label);
  const cardSelectors = [
    'div.group.aspect-square',
    'div.group',
    'a.group',
    'button.group',
  ];

  for (const candidate of candidates) {
    for (const selector of cardSelectors) {
      const locator = page.locator(selector).filter({ hasText: candidate }).first();
      if (await locator.count().catch(() => 0)) {
        if (await locator.isVisible().catch(() => false)) {
          await locator.click({ force: true });
          return locator;
        }
      }
    }
  }

  return clickText(page, label, description);
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
    await input.question(`${message}\nPress Enter to continue...`);
  } finally {
    input.close();
  }
}

async function ensureOn(page, targetUrl) {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function chooseCurrentContext(page) {
  if (config.boardName) {
    await clickCard(page, config.boardName, `board "${config.boardName}"`);
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  if (config.className) {
    await clickCard(page, config.className, `class/book "${config.className}"`);
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  if (config.bookName) {
    await clickCard(page, config.bookName, `book "${config.bookName}"`);
    await page.waitForLoadState('networkidle').catch(() => {});
  }
}

async function openDocumentAnalysis(page) {
  await clickFirstVisible(
    page,
    [
      'text=Document Analysis',
      'text=Analyze Your Document',
      'text=Analysis',
      'a:has-text("Analysis")',
      'button:has-text("Analysis")',
      'button:has-text("Analyze")',
    ],
    'document analysis page'
  );
}

async function openSmartQuestionPanel(page) {
  const selectors = [
    'button:has(.lucide-brain)',
    'button:has(svg.lucide-brain)',
    'button[aria-label*="Smart Questions" i]',
    'button[title*="Smart Questions" i]',
    '[data-testid*="smart" i]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click({ force: true }).catch(async () => {
          const handle = await locator.elementHandle();
          if (!handle) throw new Error('Could not open Smart Questions panel');
          await handle.evaluate((element) => {
            const clickable = element.closest('button, a, [role="button"]') || element;
            clickable.click();
          });
        });
        await page.waitForTimeout(500);
        return;
      }
    }
  }

  await clickAny(
    page,
    [
      'text=Smart Questions',
      'text=Smart Question',
      'button:has-text("Smart Questions")',
      'button:has-text("Smart Question")',
    ],
    'Smart Questions panel'
  );
}

function uniqueByNormalizedText(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const normalized = normalizeLabel(item.text || item.question || item.answer || '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(item);
  }
  return output;
}

function isNoiseQuestionText(text) {
  return [
    /^hindi$/i,
    /^question paper$/i,
    /^whiteboard$/i,
    /^q&a$/i,
    /^create a lesson plan/i,
    /^create a semester plan/i,
    /^new chat$/i,
    /^knoi$/i,
    /^ashutosh$/i,
    /^refresh$/i,
    /^quick summary$/i,
    /^key insights$/i,
    /^ask me anything about this document/i,
    /^exploring:/i,
  ].some((pattern) => pattern.test(text));
}

function isQuestionLikeText(text) {
  const normalized = normalizeLabel(text);
  if (!normalized || normalized.length < 4) return false;
  if (isNoiseQuestionText(normalized)) return false;
  if (/^[^\p{L}\p{N}]+$/u.test(normalized)) return false;

  const wordCount = normalized.split(' ').filter(Boolean).length;
  const questionCues = [
    /^what\b/i,
    /^why\b/i,
    /^how\b/i,
    /^when\b/i,
    /^where\b/i,
    /^which\b/i,
    /^who\b/i,
    /^whom\b/i,
    /^whose\b/i,
    /^explain\b/i,
    /^describe\b/i,
    /^define\b/i,
    /^compare\b/i,
    /^contrast\b/i,
    /^list\b/i,
    /^state\b/i,
    /^write\b/i,
    /^give\b/i,
    /^calculate\b/i,
    /^derive\b/i,
    /^name\b/i,
    /^mention\b/i,
    /^prove\b/i,
    /^solve\b/i,
    /^discuss\b/i,
    /^summarize\b/i,
    /^identify\b/i,
    /^justify\b/i,
    /^show\b/i,
  ];

  return /\?$/.test(normalized) || /^\d+\s+/.test(normalized) || questionCues.some((pattern) => pattern.test(normalized)) || wordCount >= 6;
}

function stripQuestionPrefix(text) {
  return String(text || '').replace(/^\s*\d+[\s.)-:]*/, '');
}

function normalizeQuestionDisplayText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !/^[<>›»]+$/.test(line))
    .filter((line) => !/^smart questions$/i.test(line))
    .filter((line) => !/^close$/i.test(line))
    .filter((line) => !/^x$/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function questionMatchScore(leftText, rightText) {
  const left = normalizeLabel(stripQuestionPrefix(normalizeQuestionDisplayText(leftText)));
  const right = normalizeLabel(stripQuestionPrefix(normalizeQuestionDisplayText(rightText)));
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  return tokenOverlapRatio(left, right);
}

function isSameQuestion(leftText, rightText) {
  return questionMatchScore(leftText, rightText) >= 0.75;
}

async function findSmartQuestionsPanelRoot(page) {
  const titleLocator = page.getByText(/^\s*Smart Questions\s*$/i).first();
  if (await titleLocator.count().catch(() => 0)) {
    const fixedRoot = titleLocator.locator('xpath=ancestor::*[contains(@class, "fixed")][1]');
    if (await fixedRoot.count().catch(() => 0)) {
      return fixedRoot;
    }

    const rootedPanel = titleLocator.locator('xpath=ancestor::div[.//button][1]');
    if (await rootedPanel.count().catch(() => 0)) {
      return rootedPanel;
    }
  }

  const fallbacks = [
    'div.fixed.bottom-24',
    'div.fixed.bottom-16',
    'div.fixed',
    'div[role="dialog"]',
    'div[class*="fixed"]',
    'div[class*="bottom"]',
  ];

  for (const selector of fallbacks) {
    const locator = page.locator(selector).filter({ hasText: /Smart Questions/i }).first();
    if (await locator.count().catch(() => 0)) {
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
  }

  return null;
}

async function collectLivePanelQuestions(page) {
  const panel = await findSmartQuestionsPanelRoot(page);
  if (!panel) return [];

  const buttons = panel.locator('button');
  const count = await buttons.count().catch(() => 0);
  const questions = [];

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const rawText = (await button.innerText().catch(() => '')).trim();
    const questionText = normalizeQuestionDisplayText(rawText);
    if (!questionText) continue;
    if (isNoiseQuestionText(questionText)) continue;
    if (/^smart questions$/i.test(questionText)) continue;
    if (/^close$/i.test(questionText) || /^x$/i.test(questionText)) continue;
    if (questionText.length < 6 && !/^\d+\s+/.test(questionText)) continue;

    questions.push({
      panelIndex: index,
      locator: button,
      text: questionText,
      rawText,
    });
  }

  return uniqueByNormalizedText(questions);
}

function isLikelyVisibleBox(stats) {
  return stats && stats.visible && (stats.textLength > 0 || stats.imageCount > 0);
}

const answerCandidateSelectors = [
  config.answerSelector,
  '[data-message-role="assistant"]',
  '[data-role="assistant"]',
  '[data-testid*="assistant" i]',
  '[aria-label*="assistant" i]',
  '[class*="assistant" i]',
  '[class*="answer" i]',
  '[class*="message" i]',
  '[role="article"]',
  '[role="listitem"]',
  '[role="tabpanel"]',
  'main article',
  'main section',
];

const composerSelectors = [
  'textarea',
  '[contenteditable="true"]',
  '[role="textbox"]',
  'input[placeholder*="Ask" i]',
  'textarea[placeholder*="Ask" i]',
  'input[aria-label*="Ask" i]',
  'textarea[aria-label*="Ask" i]',
  '[placeholder*="Ask" i]',
  '[aria-label*="Ask" i]',
];

async function waitForComposerReady(page, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const locator = await getQuestionInputLocator(page).catch(() => null);
    if (locator && (await locator.isVisible().catch(() => false)) && !(await locator.isDisabled().catch(() => true))) {
      return locator;
    }
    await page.waitForTimeout(750);
  }

  throw new Error('Smart question composer did not become ready in time');
}

async function clickSmartQuestion(page, questionRef) {
  const questionText = String(questionRef?.question ?? questionRef?.text ?? questionRef ?? '');
  const normalizedQuestion = normalizeLabel(questionText);
  const normalizedQuestionBody = normalizeLabel(questionText.replace(/^\d+\s*/, ''));

  const directLocator = questionRef?.locator;
  if (directLocator) {
    try {
      if (await directLocator.isVisible().catch(() => false)) {
        await directLocator.scrollIntoViewIfNeeded().catch(() => {});
        await directLocator.click({ force: true });
        return { locator: directLocator, clickedText: questionText };
      }
    } catch (error) {
      // Fall through to text matching if the stored locator is stale.
    }
  }

  const livePanelCandidates = await collectLivePanelQuestions(page).catch(() => []);
  const questionPanelIndex = Number.isInteger(questionRef?.panelIndex) ? questionRef.panelIndex : null;
  if (questionPanelIndex !== null) {
    const candidate = livePanelCandidates.find((item) => item.panelIndex === questionPanelIndex);
    if (candidate) {
      await candidate.locator.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await candidate.locator.click({ force: true });
      } catch (error) {
        const elementHandle = await candidate.locator.elementHandle();
        if (!elementHandle) throw error;
        await elementHandle.evaluate((element) => {
          const clickable = element.closest('button, a, [role="button"], li, div[role="button"]') || element;
          clickable.click();
        });
      }
      return { locator: candidate.locator, clickedText: candidate.text };
    }
  }

  const questionSourceText = normalizeLabel(questionRef?.rawText || questionRef?.question || questionRef?.text || questionText);
  for (const candidate of livePanelCandidates) {
    const candidateText = normalizeLabel(candidate.rawText || candidate.text || '');
    if (
      isSameQuestion(candidate.text, questionText) ||
      (questionSourceText && candidateText && questionSourceText === candidateText) ||
      (questionSourceText && candidateText && (questionSourceText.includes(candidateText) || candidateText.includes(questionSourceText)))
    ) {
      await candidate.locator.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await candidate.locator.click({ force: true });
      } catch (error) {
        const elementHandle = await candidate.locator.elementHandle();
        if (!elementHandle) throw error;
        await elementHandle.evaluate((element) => {
          const clickable = element.closest('button, a, [role="button"], li, div[role="button"]') || element;
          clickable.click();
        });
      }
      return { locator: candidate.locator, clickedText: candidate.text };
    }
  }

  const textSnippets = [
    questionText,
    normalizedQuestionBody.slice(0, 48),
    normalizedQuestionBody.slice(0, 32),
  ].filter((value, index, array) => value && array.indexOf(value) === index);

  const locatorFactories = [];
  for (const snippet of textSnippets) {
    locatorFactories.push(() => page.getByText(snippet, { exact: false }).first());
    locatorFactories.push(() =>
      page
        .locator('button, [role="button"], a, li, div[role="button"], span, p, div')
        .filter({ hasText: snippet })
        .first()
    );
  }

  for (const getLocator of locatorFactories) {
    const locator = getLocator();
    if (!(await locator.count().catch(() => 0))) continue;

    const text = normalizeLabel(await locator.textContent().catch(() => ''));
    if (!text) continue;
    const textBody = normalizeLabel(text.replace(/^\d+\s*/, ''));
    const matchesQuestion =
      text === normalizedQuestion ||
      textBody === normalizedQuestionBody ||
      text.includes(normalizedQuestionBody) ||
      normalizedQuestionBody.includes(textBody) ||
      text.includes(normalizedQuestion) ||
      normalizedQuestion.includes(text);

    if (!matchesQuestion) continue;

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await locator.click({ force: true });
    } catch (error) {
      const elementHandle = await locator.elementHandle();
      if (!elementHandle) throw error;
      await elementHandle.evaluate((element) => {
        const clickable = element.closest('button, a, [role="button"], li, div[role="button"]') || element;
        clickable.click();
      });
    }
    return { locator, clickedText: text };
  }

  const visibleCandidates = await collectVisibleQuestionCandidates(page);
  for (const candidate of visibleCandidates) {
    const text = normalizeLabel(candidate.text);
    const textBody = normalizeLabel(text.replace(/^\d+\s*/, ''));
    const matchesQuestion =
      text === normalizedQuestion ||
      textBody === normalizedQuestionBody ||
      text.includes(normalizedQuestionBody) ||
      normalizedQuestionBody.includes(textBody) ||
      text.includes(normalizedQuestion) ||
      normalizedQuestion.includes(text);

    if (!matchesQuestion) continue;

    await candidate.locator.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await candidate.locator.click({ force: true });
    } catch (error) {
      const elementHandle = await candidate.locator.elementHandle();
      if (!elementHandle) throw error;
      await elementHandle.evaluate((element) => {
        const clickable = element.closest('button, a, [role="button"], li, div[role="button"]') || element;
        clickable.click();
      });
    }
    return { locator: candidate.locator, clickedText: candidate.text };
  }

  await dumpDebug(page, 'smart-question-click-failure');
  const visibleTexts = await page
    .locator('button, [role="button"], a, li, div[role="button"], span, p')
    .evaluateAll((elements) =>
      elements
        .map((element) => (element.innerText || '').trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .slice(0, 80)
    )
    .catch(() => []);
  console.log('Visible text candidates:');
  for (const candidate of visibleTexts) {
    console.log(`- ${candidate}`);
  }

  throw new Error(`Could not find smart question tile for: ${questionText}`);
}

async function collectVisibleQuestionCandidates(page) {
  const selectors = [
    'button',
    '[role="button"]',
    'a',
    'li',
    'div[role="button"]',
    'span',
    'p',
  ];
  const candidates = [];

  for (const selector of selectors) {
    const locators = page.locator(selector);
    const count = await locators.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const locator = locators.nth(index);
      if (!(await locator.isVisible().catch(() => false))) continue;
      const text = (await locator.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
      if (!text || text.length < 3) continue;
      if (!isQuestionLikeText(text)) continue;

      const box = await locator.boundingBox().catch(() => null);
      if (!box) continue;

      candidates.push({ locator, text, box });
    }
  }

  candidates.sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);
  return uniqueByNormalizedText(candidates);
}

function tokenOverlapRatio(leftText, rightText) {
  const leftTokens = new Set(normalizeLabel(leftText).split(' ').filter(Boolean));
  const rightTokens = new Set(normalizeLabel(rightText).split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

async function snapshotAnswerCandidates(page) {
  const snapshot = [];
  const viewport = page.viewportSize() || { width: 1440, height: 900 };

  for (const selector of answerCandidateSelectors) {
    const locators = page.locator(selector);
    const count = await locators.count().catch(() => 0);

    for (let index = 0; index < Math.min(count, 25); index += 1) {
      const locator = locators.nth(index);
      if (!(await locator.isVisible().catch(() => false))) continue;
      const tagName = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
      if (['textarea', 'input', 'select', 'option', 'button'].includes(tagName)) continue;
      const role = await locator.getAttribute('role').catch(() => '');
      if (role && ['textbox', 'button', 'combobox'].includes(role.toLowerCase())) continue;
      if (await locator.evaluate((element) => element.matches('[contenteditable="true"]')).catch(() => false)) continue;

      const text = (await locator.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
      const imageCount = await locator.locator('img').count().catch(() => 0);
      if (!text && !imageCount) continue;
      if (/^ask me anything about this document/i.test(text)) continue;
      if (text.length < 8 && !imageCount) continue;

      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        const nearBottomComposer = box.y > viewport.height * 0.72;
        const farRightQuestion = box.x > viewport.width * 0.62;
        const oversizedContainer = box.width > viewport.width * 0.85 || box.height > viewport.height * 0.6;
        if (nearBottomComposer && !imageCount) continue;
        if (farRightQuestion && !imageCount) continue;
        if (oversizedContainer && !imageCount) continue;
      }

      snapshot.push({
        selector,
        index,
        text,
        textLength: text.length,
        imageCount,
        box,
      });
    }
  }

  return snapshot;
}

function answerSignature(candidate) {
  return `${candidate.text.slice(0, 160)}|${candidate.imageCount}`;
}

async function findBestAnswerCandidate(page, beforeSignatures = new Set()) {
  const candidates = await snapshotAnswerCandidates(page);
  if (!candidates.length) return null;

  for (const selector of answerCandidateSelectors) {
    const matchingCandidates = candidates.filter(
      (candidate) => candidate.selector === selector && candidate.text && !beforeSignatures.has(answerSignature(candidate))
    );
    const newMatchingCandidates = matchingCandidates;
    if (newMatchingCandidates.length) {
      newMatchingCandidates.sort((left, right) => {
        const scoreLeft = left.textLength + left.imageCount * 1000;
        const scoreRight = right.textLength + right.imageCount * 1000;
        return scoreRight - scoreLeft;
      });
      return newMatchingCandidates[0];
    }
  }

  candidates.sort((left, right) => {
    const scoreLeft = left.textLength + left.imageCount * 1000;
    const scoreRight = right.textLength + right.imageCount * 1000;
    return scoreRight - scoreLeft;
  });

  return candidates[0];
}

async function captureAnswerForQuestion(page, questionRef, outputBaseName) {
  const questionText = String(questionRef?.question ?? questionRef?.text ?? questionRef ?? '');
  const retryLimit = 2;
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    const beforeCandidates = await snapshotAnswerCandidates(page);
    const beforeSignatures = new Set(beforeCandidates.map(answerSignature));

    await openSmartQuestionPanel(page).catch(() => {});
    const clickedQuestion = await clickSmartQuestion(page, questionRef);
    console.log(`Clicked: ${clickedQuestion.clickedText}`);
    console.log('Waiting for answer generation...');
    await page.waitForTimeout(1000);
    await page.getByText(/analyzing document/i).first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

    const deadline = Date.now() + config.answerWaitTimeoutMs;
    let seenAnalyzingState = false;
    while (Date.now() < deadline) {
      const analyzingVisible = await page.getByText(/analyzing document/i).first().isVisible().catch(() => false);
      if (analyzingVisible) {
        seenAnalyzingState = true;
      }

      const bestCandidate = await findBestAnswerCandidate(page, beforeSignatures);
      if (!bestCandidate) {
        await page.waitForTimeout(750);
        continue;
      }

      const answerContainer = page.locator(bestCandidate.selector).nth(bestCandidate.index);
      const answerText = (await answerContainer.innerText().catch(() => '')).trim();

      if (isGenericUnavailableAnswer(answerText)) {
        console.log('Captured unavailable-answer fallback.');
        const imageFiles = await saveAnswerImages(answerContainer, outputBaseName);
        return {
          answerText,
          imageFiles,
          status: 'ok',
        };
      }

      const signature = answerSignature(bestCandidate);
      const normalizedBest = normalizeLabel(bestCandidate.text);
      const normalizedClicked = normalizeLabel(clickedQuestion.clickedText);
      const overlapWithClicked = tokenOverlapRatio(bestCandidate.text, clickedQuestion.clickedText);
      const looksLikeQuestionBubble =
        normalizedBest === normalizedClicked ||
        normalizedBest.includes(normalizedClicked) ||
        normalizedClicked.includes(normalizedBest) ||
        overlapWithClicked > 0.7;

      const viewport = page.viewportSize() || { width: 1440, height: 900 };
      const isLikelyAnswerSide = bestCandidate.box ? bestCandidate.box.x < viewport.width * 0.62 : true;
      const hasEnoughContent = bestCandidate.textLength >= 20 || bestCandidate.imageCount > 0;
      const errorText = normalizeLabel(answerText);
      const answerLooksValid =
        answerText &&
        !looksLikeQuestionBubble &&
        isLikelyAnswerSide &&
        hasEnoughContent &&
        !/^smart questions$/i.test(answerText) &&
        !/^analyzing document$/i.test(answerText);

      if (
        answerLooksValid &&
        !beforeSignatures.has(signature)
      ) {
        if (
          errorText.includes('request timed out') &&
          errorText.includes('please try again') &&
          attempt < retryLimit
        ) {
          console.log(`Retrying question after timeout error (attempt ${attempt + 1}/${retryLimit})...`);
          break;
        }

        console.log('Answer captured.');
        const imageFiles = await saveAnswerImages(answerContainer, outputBaseName);
        return {
          answerText,
          imageFiles,
          status: 'ok',
        };
      }

      await page.waitForTimeout(750);
    }

    if (attempt < retryLimit) {
      await page.waitForTimeout(1000);
      continue;
    }

    console.log(`Timed out after ${Math.round(config.answerWaitTimeoutMs / 60000)} min waiting for answer: ${questionText}`);
    return {
      answerText: '',
      imageFiles: [],
      status: 'timeout',
    };
  }

  return {
    answerText: '',
    imageFiles: [],
    status: 'timeout',
  };
}

async function waitForSmartQuestionsToLoad(page, timeout = config.questionLoadTimeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const candidates = await collectLivePanelQuestions(page).catch(() => []);
    if (candidates.length) return candidates;
    await page.waitForTimeout(500);
  }

  return [];
}

async function extractLiveSmartQuestions(page) {
  await openSmartQuestionPanel(page);
  const candidates = await waitForSmartQuestionsToLoad(page);
  const questions = uniqueByNormalizedText(
    candidates
      .map((candidate) => ({
        panelIndex: candidate.panelIndex,
        question: candidate.text,
        locator: candidate.locator,
        rawText: candidate.rawText,
      }))
      .filter((candidate) => isQuestionLikeText(candidate.question))
  );

  if (!questions.length) {
    await dumpDebug(page, 'smart-question-extraction-failure');
    throw new Error('No live Smart Questions were found on the page');
  }

  return questions.map((question, index) => ({
    sourceLine: index + 1,
    sl: String(index + 1),
    board: config.boardName,
    className: config.className,
    book: config.bookName,
    question: question.question,
    answer: '',
    locator: question.locator,
    panelIndex: question.panelIndex,
  }));
}

async function saveAnswerImages(answerContainer, outputBaseName) {
  const imageLocators = answerContainer.locator('img');
  const imageCount = await imageLocators.count().catch(() => 0);
  if (!imageCount) return [];

  await fsPromises.mkdir(config.imageOutputDir, { recursive: true });

  const savedFiles = [];
  for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
    const imageLocator = imageLocators.nth(imageIndex);
    const fileName = `${outputBaseName}-image-${String(imageIndex + 1).padStart(2, '0')}.png`;
    const filePath = path.resolve(config.imageOutputDir, fileName);
    await imageLocator.screenshot({ path: filePath }).catch(() => {});
    if (fs.existsSync(filePath)) {
      savedFiles.push(path.relative(process.cwd(), filePath));
    }
  }

  return savedFiles;
}

function buildOutputBaseName(bookStem, questionIndex) {
  const prefix = toReadableFileStem(bookStem, config.outputPrefix);
  return `${prefix}-q-${String(questionIndex).padStart(3, '0')}`;
}

function toCsv(rows) {
  const headers = ['source_line', 'sl', 'book', 'question', 'answer', 'image_files', 'status', 'error_message'];
  const escapeCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [`\uFEFF${headers.map(escapeCell).join(',')}`];
  for (const row of rows) {
    lines.push([
      row.sourceLine,
      row.sl,
      row.book,
      row.question,
      row.answer,
      row.imageFiles && row.imageFiles.length ? row.imageFiles.join(' | ') : '',
      row.status || '',
      row.errorMessage || '',
    ].map(escapeCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function sanitizeDelimitedText(value) {
  return String(value ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeExportRows(rows) {
  return rows.map((row) => ({
    ...row,
    question: sanitizeDelimitedText(row.question),
    answer: sanitizeDelimitedText(row.answer),
    imageFiles: Array.isArray(row.imageFiles) ? row.imageFiles : [],
    status: sanitizeDelimitedText(row.status),
    errorMessage: sanitizeDelimitedText(row.errorMessage),
  }));
}

async function exportResults(rows) {
  const jsonPath = path.resolve(`${config.outputPrefix}.json`);
  const csvPath = path.resolve(`${config.outputPrefix}.csv`);
  const xlsxPath = path.resolve(`${config.outputPrefix}.xlsx`);

  await fsPromises.writeFile(jsonPath, JSON.stringify(rows, null, 2), 'utf8');
  const jsonRows = JSON.parse(await fsPromises.readFile(jsonPath, 'utf8'));
  const exportRows = normalizeExportRows(jsonRows);
  await fsPromises.writeFile(csvPath, toCsv(exportRows), 'utf8');
  await writeExcelWorkbook(exportRows, xlsxPath).catch((error) => {
    console.log(`Excel export skipped: ${error.message}`);
  });

  return { jsonPath, csvPath, xlsxPath };
}

async function writeExcelWorkbook(rows, xlsxPath) {
  const escapedXlsxPath = xlsxPath.replace(/'/g, "''");
  const tempJsonPath = path.resolve(`${config.outputPrefix}.excel-temp.json`);
  await fsPromises.writeFile(tempJsonPath, JSON.stringify(rows, null, 2), 'utf8');
  const escapedTempJsonPath = tempJsonPath.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
$rows = Get-Content -Raw -LiteralPath '${escapedTempJsonPath}' | ConvertFrom-Json
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$workbook = $excel.Workbooks.Add()
$pairsSheet = $workbook.Worksheets.Item(1)
$pairsSheet.Name = 'Pairs'
$headers = @('source_line','sl','book','question','answer','image_files','status','error_message')
for ($i = 0; $i -lt $headers.Count; $i++) {
  $pairsSheet.Cells.Item(1, $i + 1) = $headers[$i]
}
for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {
  $row = $rows[$rowIndex]
  $values = @(
    $row.sourceLine,
    $row.sl,
    $row.book,
    $row.question,
    $row.answer,
    ($row.imageFiles -join ' | '),
    $row.status,
    $row.errorMessage
  )
  for ($columnIndex = 0; $columnIndex -lt $values.Count; $columnIndex++) {
    $pairsSheet.Cells.Item($rowIndex + 2, $columnIndex + 1) = $values[$columnIndex]
  }
}

$wideSheet = $workbook.Worksheets.Add()
$wideSheet.Name = 'Wide'
if ($rows.Count -gt 0) {
  $wideHeaders = @()
  for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {
    $displayIndex = $rowIndex + 1
    $wideHeaders += "Q$displayIndex"
    $wideHeaders += "Ans$displayIndex"
  }
  for ($columnIndex = 0; $columnIndex -lt $wideHeaders.Count; $columnIndex++) {
    $wideSheet.Cells.Item(1, $columnIndex + 1) = $wideHeaders[$columnIndex]
  }
  for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {
    $row = $rows[$rowIndex]
    $questionColumn = ($rowIndex * 2) + 1
    $answerColumn = $questionColumn + 1
    $wideSheet.Cells.Item(2, $questionColumn) = $row.question
    $wideSheet.Cells.Item(2, $answerColumn) = $row.answer
  }
}

$workbook.SaveAs('${escapedXlsxPath}', 51)
$pairsSheet.UsedRange.Columns.AutoFit() | Out-Null
$pairsSheet.UsedRange.Rows.AutoFit() | Out-Null
$wideSheet.UsedRange.Columns.AutoFit() | Out-Null
$wideSheet.UsedRange.Rows.AutoFit() | Out-Null
$workbook.Close($true)
$excel.Quit()
`;

  try {
    const result = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: 'pipe',
    });

    const exitCode = await new Promise((resolve) => {
      result.on('exit', resolve);
    });

    if (exitCode !== 0) {
      throw new Error(`PowerShell Excel export failed with exit code ${exitCode}`);
    }
  } finally {
    await fsPromises.unlink(tempJsonPath).catch(() => {});
  }
}

async function dumpDebug(page, label) {
  return label;
}

function extractDocumentName(pageTitle) {
  const title = String(pageTitle || '');
  const match = title.match(/Exploring:\s*([^\r\n]+)/i);
  const rawName = (match ? match[1] : title).trim();
  return rawName.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractPdfStemFromUrl(urlString) {
  if (!urlString) return '';

  try {
    const url = new URL(urlString);
    const pathMatch = path.basename(url.pathname || '');
    if (pathMatch && /\.pdf$/i.test(pathMatch)) {
      return sanitizeFileStem(pathMatch.replace(/\.pdf$/i, ''));
    }

    const searchParams = ['filename', 'file', 'name', 'document', 'pdf'];
    for (const key of searchParams) {
      const value = url.searchParams.get(key);
      if (value && /\.pdf$/i.test(value)) {
        return sanitizeFileStem(value.replace(/\.pdf$/i, ''));
      }
    }
  } catch (error) {
    // Ignore malformed URLs and fall back to other strategies.
  }

  const raw = String(urlString).match(/([^/?#]+)\.pdf(?:$|[?#])/i)?.[1] || '';
  return raw ? sanitizeFileStem(raw) : '';
}

async function inferOutputStem(page, fallbackTitle = '') {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const exploringMatch = String(bodyText || '').match(/Exploring:\s*([^\n]+)/i);
  const exploringLabel = exploringMatch ? exploringMatch[1] : '';
  if (exploringLabel) {
    return toReadableFileStem(exploringLabel);
  }

  const pageUrl = page.url();
  const urlStem = extractPdfStemFromUrl(pageUrl);
  if (urlStem) {
    return urlStem;
  }

  const pdfLink = page.locator('a[href*=".pdf" i], iframe[src*=".pdf" i], embed[src*=".pdf" i]').first();
  if (await pdfLink.count().catch(() => 0)) {
    const href = await pdfLink.getAttribute('href').catch(() => '') || await pdfLink.getAttribute('src').catch(() => '');
    const linkStem = extractPdfStemFromUrl(href);
    if (linkStem) {
      return linkStem;
    }
  }

  const titleStem = extractDocumentName(fallbackTitle || (await page.title().catch(() => '')));
  if (titleStem) {
    return toReadableFileStem(titleStem);
  }

  return sanitizeFileStem('knoi-smart-questions');
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
  if (config.dryRun) {
    const questions = await loadQuestionsFromCsv(config.questionCsvPath, config.questionStartLine);
    if (!questions.length) {
      throw new Error(`No questions found from ${config.questionCsvPath} starting at line ${config.questionStartLine}`);
    }

    console.log(`Dry run: loaded ${questions.length} questions from line ${config.questionStartLine} onward`);
    console.log(`Questions file: ${config.questionCsvPath}`);
    for (const question of questions) {
      console.log(
        JSON.stringify(
          {
            sourceLine: question.sourceLine,
            sl: question.sl,
            question: question.question,
          },
          null,
          2
        )
      );
    }
    return;
  }

  startKeepAwake();
  let session = await createBrowserSession();
  let existingPages = session.context.pages();
  let page = existingPages[0] || (await session.context.newPage());
  await page.bringToFront().catch(() => {});
  try {
    await ensureOn(page, ensureAbsoluteUrl(config.baseUrl, config.loginPath));
    await waitForEnter('Sign in manually, then navigate to your board/book/document page');

    await waitForEnter('Open the target document analysis page and press Enter to start Smart Questions');

    let questions = [];
    if (config.questionSource === 'file') {
      questions = await loadQuestionsFromCsv(config.questionCsvPath, config.questionStartLine);
      if (!questions.length) {
        throw new Error(`No questions found from ${config.questionCsvPath} starting at line ${config.questionStartLine}`);
      }
      console.log(`Loaded ${questions.length} questions from file mode`);
      console.log(`Questions file: ${config.questionCsvPath}`);
    } else {
      try {
        questions = await extractLiveSmartQuestions(page);
      } catch (error) {
        console.log(`Live Smart Question extraction failed at URL: ${page.url()}`);
        console.log(`Page title: ${await page.title().catch(() => '')}`);
        await dumpDebug(page, 'smart-question-panel-failure');
        throw error;
      }
      console.log(`Loaded ${questions.length} live Smart Questions from the page`);
    }

    const pageTitle = await page.title().catch(() => '');
    const pageBodyText = await page.locator('body').innerText().catch(() => '');
    const documentName = normalizeExploringLabel(extractDocumentName(pageBodyText || pageTitle));
    const inferredOutputPrefix = await inferOutputStem(page, pageTitle);
    config.outputPrefix = process.env.OUTPUT_PREFIX
      ? sanitizeFileStem(config.outputPrefix, inferredOutputPrefix)
      : inferredOutputPrefix;
    const checkpointPath = getCheckpointPath();
    const currentPageUrl = page.url();
    let results = [];
    let startIndex = 0;
    const checkpoint = config.resumeFromCheckpoint ? await loadRunCheckpoint(checkpointPath) : null;
    if (
      checkpoint &&
      Array.isArray(checkpoint.questions) &&
      Array.isArray(checkpoint.results) &&
      checkpoint.questions.length &&
      checkpoint.results.length <= checkpoint.questions.length
    ) {
      questions = checkpoint.questions;
      results = checkpoint.results;
      startIndex = results.length;
      console.log(`Resuming from checkpoint: ${startIndex}/${questions.length} questions already completed`);
    }

    await saveRunCheckpoint(checkpointPath, {
      createdAt: checkpoint?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      outputPrefix: config.outputPrefix,
      questions,
      results,
      nextIndex: startIndex,
      pageUrl: checkpoint?.pageUrl || currentPageUrl,
    });

    for (let index = startIndex; index < questions.length; index += 1) {
      const question = questions[index];
      const questionIndex = index + 1;
      const outputBaseName = buildOutputBaseName(config.outputPrefix, questionIndex);
      console.log(`Submitting question ${questionIndex}: ${question.question}`);
      let captured;
      try {
        captured = await captureAnswerForQuestion(page, question, outputBaseName);
      } catch (error) {
        if (isRecoverableSessionError(error)) {
          console.log(`Browser session dropped while processing question ${questionIndex}. Reconnecting...`);
          await saveRunCheckpoint(checkpointPath, {
            createdAt: checkpoint?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            outputPrefix: config.outputPrefix,
            questions,
            results,
            nextIndex: index,
            pageUrl: page.url(),
          });
          await session.browser.close().catch(() => {});
          session = await createBrowserSession();
          existingPages = session.context.pages();
          page = existingPages[0] || (await session.context.newPage());
          await page.bringToFront().catch(() => {});
          const resumeUrl = checkpoint?.pageUrl || ensureAbsoluteUrl(config.baseUrl, config.loginPath);
          if (resumeUrl) {
            await page.goto(resumeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
          }
          console.log('Session restored. Re-run the question if the page is visible again.');
          captured = await captureAnswerForQuestion(page, question, outputBaseName).catch((retryError) => {
            console.log(`Question ${questionIndex} failed after reconnect: ${retryError.message}`);
            return {
              answerText: '',
              imageFiles: [],
              status: 'error',
              errorMessage: retryError.message,
            };
          });
        } else {
          console.log(`Question ${questionIndex} failed: ${error.message}`);
          captured = {
            answerText: '',
            imageFiles: [],
            status: 'error',
            errorMessage: error.message,
          };
        }
      }
      const row = {
        sourceLine: question.sourceLine ?? questionIndex,
        sl: question.sl ?? String(questionIndex),
        book: question.book || documentName || config.bookName,
        question: question.question,
        answer: captured.answerText,
        imageFiles: captured.imageFiles,
        questionIndex,
        status: captured.status || 'ok',
        errorMessage: captured.errorMessage || '',
      };
      results.push(row);
      console.log(JSON.stringify(row, null, 2));
      await saveRunCheckpoint(checkpointPath, {
        createdAt: checkpoint?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        outputPrefix: config.outputPrefix,
        questions,
        results,
        nextIndex: index + 1,
        pageUrl: page.url(),
      });
      await page.waitForTimeout(config.questionDelayMs).catch(() => {});
    }

    const output = await exportResults(results);
    console.log(`Saved ${results.length} rows to ${output.csvPath}, ${output.jsonPath}, and ${output.xlsxPath}`);
    await clearRunCheckpoint(checkpointPath);
  } finally {
    if (session.ownsBrowser) {
      await session.browser.close().catch(() => {});
    }
    await stopKeepAwake();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { run };
