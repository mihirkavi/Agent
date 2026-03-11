import fs from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeDomain(value: string): string {
  const stripped = value.trim().toLowerCase().replace(/^https?:\/\//, "");
  return stripped.replace(/^www\./, "").split("/")[0] ?? stripped;
}

export class DomainApprovalRequiredError extends Error {
  constructor(public readonly domain: string) {
    super(`Domain approval required for ${domain}`);
  }
}

type BrowserSnapshot = {
  title: string;
  url: string;
  headings: string[];
  buttons: string[];
  links: Array<{ text: string; href: string }>;
  fields: Array<{
    label: string;
    name: string;
    placeholder: string;
    tag: string;
    type: string;
  }>;
  visibleText: string;
};

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly visitedUrls = new Set<string>();

  constructor(
    private readonly taskId: string,
    private readonly allowedDomains: Set<string>,
    private readonly artifactDir: string,
    private readonly headless: boolean
  ) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 1024 }
    });
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
    this.page = null;
  }

  getCurrentUrl(): string {
    return this.page?.url() ?? "";
  }

  getVisitedUrls(): string[] {
    return Array.from(this.visitedUrls);
  }

  async navigate(rawUrl: string): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    const url = this.normalizeUrl(rawUrl);
    this.ensureDomainAllowed(url);

    await page.goto(url, {
      timeout: 45_000,
      waitUntil: "domcontentloaded"
    });
    await page.waitForTimeout(900);
    await this.captureNavigation(url);
    return this.snapshot();
  }

  async click(target: string): Promise<BrowserSnapshot> {
    const locator = await this.findClickable(target);
    await locator.click({
      timeout: 15_000
    });
    await this.waitForSettled();
    await this.captureNavigation(this.requirePage().url());
    return this.snapshot();
  }

  async fill(field: string, value: string): Promise<BrowserSnapshot> {
    const locator = await this.findField(field);
    await locator.fill(value, {
      timeout: 15_000
    });
    return this.snapshot();
  }

  async select(field: string, option: string): Promise<BrowserSnapshot> {
    const locator = await this.findField(field);
    await locator.selectOption({ label: option }).catch(async () => {
      await locator.selectOption({ value: option });
    });
    return this.snapshot();
  }

  async press(key: string): Promise<BrowserSnapshot> {
    await this.requirePage().keyboard.press(key);
    await this.waitForSettled();
    return this.snapshot();
  }

  async wait(seconds: number): Promise<BrowserSnapshot> {
    await this.requirePage().waitForTimeout(seconds * 1000);
    return this.snapshot();
  }

  async readVisibleText(maxChars = 3200): Promise<string> {
    const snapshot = await this.snapshot();
    return snapshot.visibleText.slice(0, maxChars);
  }

  async saveScreenshot(): Promise<string> {
    const page = this.requirePage();
    await fs.mkdir(this.artifactDir, { recursive: true });
    const filePath = path.resolve(this.artifactDir, `${this.taskId}.png`);
    await page.screenshot({
      fullPage: true,
      path: filePath
    });
    return `/artifacts/${this.taskId}.png`;
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    await this.captureNavigation(page.url());

    return page.evaluate(() => {
      const squash = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const unique = <T,>(items: T[]): T[] => Array.from(new Set(items));
      const textFrom = (element: Element): string =>
        squash(
          element.textContent ||
            element.getAttribute("aria-label") ||
            element.getAttribute("value")
        );

      const headings = unique(
        Array.from(document.querySelectorAll("h1, h2, h3"))
          .map((element) => textFrom(element))
          .filter(Boolean)
      ).slice(0, 12);

      const buttons = unique(
        Array.from(
          document.querySelectorAll(
            "button, [role='button'], input[type='submit'], input[type='button']"
          )
        )
          .map((element) => textFrom(element))
          .filter(Boolean)
      ).slice(0, 18);

      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((element) => ({
          text: textFrom(element),
          href: (element as HTMLAnchorElement).href
        }))
        .filter((link) => link.text || link.href)
        .slice(0, 24);

      const fields = Array.from(
        document.querySelectorAll("input, textarea, select")
      )
        .map((element) => {
          const id = element.getAttribute("id");
          const parentLabel = element.closest("label");
          const forLabel = id
            ? document.querySelector(`label[for="${id}"]`)
            : null;
          const label = squash(
            parentLabel?.textContent ||
              forLabel?.textContent ||
              element.getAttribute("aria-label") ||
              element.getAttribute("placeholder") ||
              element.getAttribute("name")
          );

          return {
            label,
            name: squash(element.getAttribute("name")),
            placeholder: squash(element.getAttribute("placeholder")),
            tag: element.tagName.toLowerCase(),
            type: squash(
              element.getAttribute("type") ||
                (element.tagName.toLowerCase() === "select" ? "select" : "text")
            )
          };
        })
        .filter(
          (field) => field.label || field.name || field.placeholder || field.type
        )
        .slice(0, 24);

      return {
        title: document.title,
        url: window.location.href,
        headings,
        buttons,
        links,
        fields,
        visibleText: squash(document.body?.innerText ?? "").slice(0, 5000)
      };
    });
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error("Browser session has not started.");
    }
    return this.page;
  }

  private normalizeUrl(rawUrl: string): string {
    const value = rawUrl.trim();
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return value;
    }
    return `https://${value}`;
  }

  private async waitForSettled(): Promise<void> {
    const page = this.requirePage();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(800);
    this.ensureDomainAllowed(page.url());
  }

  private ensureDomainAllowed(url: string): void {
    const domain = normalizeDomain(new URL(url).hostname);
    if (!this.allowedDomains.has(domain)) {
      throw new DomainApprovalRequiredError(domain);
    }
  }

  private async captureNavigation(url: string): Promise<void> {
    if (!url) {
      return;
    }
    this.ensureDomainAllowed(url);
    this.visitedUrls.add(url);
  }

  private async findClickable(target: string): Promise<Locator> {
    const page = this.requirePage();

    if (target.startsWith("css=")) {
      return page.locator(target.slice(4)).first();
    }

    const pattern = new RegExp(escapeRegex(target), "i");
    const candidates = [
      page.getByRole("button", { name: pattern }),
      page.getByRole("link", { name: pattern }),
      page.getByText(pattern).filter({ visible: true }),
      page.locator(`[aria-label*="${target}"]`)
    ];

    const locator = await this.firstVisible(candidates);
    if (!locator) {
      throw new Error(`Unable to find a clickable element matching "${target}".`);
    }
    return locator;
  }

  private async findField(field: string): Promise<Locator> {
    const page = this.requirePage();

    if (field.startsWith("css=")) {
      return page.locator(field.slice(4)).first();
    }

    const pattern = new RegExp(escapeRegex(field), "i");
    const sanitizedName = field.replace(/"/g, "");
    const candidates = [
      page.getByLabel(pattern),
      page.getByPlaceholder(pattern),
      page.getByRole("textbox", { name: pattern }),
      page.locator(`[name="${sanitizedName}"]`),
      page.locator(`input[aria-label="${sanitizedName}"], textarea[aria-label="${sanitizedName}"], select[aria-label="${sanitizedName}"]`)
    ];

    const locator = await this.firstVisible(candidates);
    if (!locator) {
      throw new Error(`Unable to find a field matching "${field}".`);
    }
    return locator;
  }

  private async firstVisible(candidates: Locator[]): Promise<Locator | null> {
    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0);
      const bounded = Math.min(count, 5);
      for (let index = 0; index < bounded; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        if (visible) {
          return candidate;
        }
      }
    }
    return null;
  }
}
