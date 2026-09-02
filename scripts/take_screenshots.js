const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  console.log("Navigating to dashboard...");
  await page.goto('http://localhost:3000/dashboard.html', { waitUntil: 'networkidle0' });
  await page.waitForTimeout(2000); // let tiles load
  await page.screenshot({ path: 'C:/Users/achuk/.gemini/antigravity-ide/brain/9280312e-d602-40cc-997b-8f463b31933f/aura_qa_1.png' });
  console.log("Captured aura_qa_1.png");

  // Open drawer
  console.log("Clicking J1 marker...");
  await page.evaluate(() => {
    document.getElementById('marker-J1').click();
  });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'C:/Users/achuk/.gemini/antigravity-ide/brain/9280312e-d602-40cc-997b-8f463b31933f/aura_qa_2.png' });
  console.log("Captured aura_qa_2.png");

  // Route
  console.log("Switching to User View...");
  await page.evaluate(() => {
    document.getElementById('tab-user-view').click();
  });
  await page.waitForTimeout(500);

  console.log("Setting origin and clicking route...");
  await page.evaluate(() => {
    document.getElementById('btn-use-location').click();
  });
  await page.waitForTimeout(1000);
  
  await page.evaluate(() => {
    document.getElementById('btn-user-route').click();
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'C:/Users/achuk/.gemini/antigravity-ide/brain/9280312e-d602-40cc-997b-8f463b31933f/aura_qa_3.png' });
  console.log("Captured aura_qa_3.png");

  await browser.close();
  console.log("Done");
})();
