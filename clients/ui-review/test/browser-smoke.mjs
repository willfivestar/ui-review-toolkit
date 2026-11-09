import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const sessionPath = process.argv[2];
assert(sessionPath, "Pass the path to a private local demo session file.");
const record = JSON.parse(await readFile(sessionPath, "utf8"));
const review = new URL(record.reviewerUrl);
const api = new URL(record.endpoint);
const loopback = (url) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
assert(loopback(review) && loopback(api), "Use only with a local synthetic demo.");
const base = new URL(review);
base.hash = "";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.UI_REVIEW_CHROME_PATH ? { executablePath: process.env.UI_REVIEW_CHROME_PATH } : {}),
});
try {
  const visitor = await browser.newPage();
  const errors = [];
  visitor.on("pageerror", (error) => errors.push(error.name));
  await visitor.goto(base.href);
  assert.equal(await visitor.locator("ui-review-next").count(), 0, "Regular visitors see no overlay.");
  assert.deepEqual(errors, []);
  await visitor.close();

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.name));
  await page.goto(review.href);
  const launch = page.getByRole("button", { name: /Open UI Review/ });
  await launch.waitFor();
  assert(!new URL(page.url()).hash.includes("review="));
  assert.equal(await page.evaluate(() => Object.hasOwn(history.state ?? {}, "__uiReviewNext")), false);
  await launch.click();
  await page.getByRole("button", { name: /^Element \(E\)/ }).click();
  const card = page.locator("#stable-card");
  // Keep a hidden value in the target to verify it is not captured.
  await card.evaluate((el) => {
    const hidden = document.createElement("span");
    hidden.hidden = true;
    hidden.textContent = "synthetic-hidden-value";
    el.append(hidden);
  });
  await card.click({ position: { x: 7, y: 7 } });
  const comment = '<img src=x onerror="window.syntheticReviewXss=true">';
  await page.locator(".context-card").getByLabel("Comment").fill(comment);
  const save = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/annotations")
  );
  await page.locator(".context-card").getByRole("button", { name: "Add" }).click();
  const saved = await save;
  assert.equal(saved.status(), 200);
  const { annotation } = await saved.json();
  assert.equal(annotation.comment, comment);
  assert(!JSON.stringify(annotation.target).includes("synthetic-hidden-value"));
  await launch.waitFor();

  await page.reload();
  await launch.click();
  await page.getByRole("button", { name: /^Notes —/ }).click();
  await page.getByText(comment, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.syntheticReviewXss), undefined);
  assert.deepEqual(errors, []);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(review.href);
  await mobile.getByRole("button", { name: /Open UI Review/ }).tap();
  await mobile.getByRole("toolbar", { name: "UI Review toolbar" }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log("Browser smoke passed: visitor isolation, fragment scrubbing, saved text, reload, and mobile toolbar.");
} catch (error) {
  // Browser exceptions can include the private navigation URL.
  throw new Error(String(error.message).replace(/#review=[a-f0-9]+/g, "#review=REDACTED"));
} finally {
  await browser.close();
}
