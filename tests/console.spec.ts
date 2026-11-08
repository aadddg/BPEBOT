import { test, expect } from "@playwright/test";
import { APP_URL, UI_SECRET, UI_TOKEN, UI_APP_ID } from "./ui-server";

test("unauthenticated and non-admin users cannot access the console or data", async ({
  page,
  context,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?reason=signin/);
  expect((await page.request.get("/api/admin/state")).status()).toBe(401);
  await context.addCookies([
    { name: "test-session", value: "member", url: APP_URL },
  ]);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?reason=forbidden/);
  await expect(page.getByText("需要管理员权限", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/admin/state")).status()).toBe(403);
});

test.describe("administrator console", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: "test-session", value: "admin", url: APP_URL },
    ]);
  });

  test("create, preview, persist, toggle and delete a command", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/dashboard/commands");
    await page.getByRole("button", { name: "新建指令", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("关键词", { exact: true }).fill("/ui-help");
    await dialog.getByLabel("回复内容", { exact: true }).fill("UI test reply");
    await dialog.getByLabel("保存前测试", { exact: true }).fill("/ui-help");
    await expect(dialog.getByText("命中此指令", { exact: true })).toBeVisible();
    await dialog.getByLabel("保存前测试", { exact: true }).fill("not a match");
    await expect(
      dialog.getByText("未匹配任何指令", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByLabel("保存前测试", { exact: true })
      .fill("/warn @member reason");
    await expect(
      dialog.getByText("被 /warn 优先匹配", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "保存指令", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    const card = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText("/ui-help", { exact: true }) });
    await expect(card).toBeVisible();
    await expect(
      card.getByText("UI test reply", { exact: true }),
    ).toBeVisible();
    await card
      .getByRole("switch", { name: "启用 /ui-help", exact: true })
      .click();
    await expect(card.getByRole("switch")).not.toBeChecked();
    await page.reload();
    await expect(card.getByText("已停用", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog
      .getByLabel("回复内容", { exact: true })
      .fill("Updated UI reply");
    await dialog.getByRole("button", { name: "保存指令", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      card.getByText("Updated UI reply", { exact: true }),
    ).toBeVisible();
    await card.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toBeVisible();
    await confirmation
      .getByRole("button", { name: "确认操作", exact: true })
      .click();
    await expect(card).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("logs paginate, filter through URL and reveal full event details", async ({
    page,
  }) => {
    await page.goto("/dashboard/logs");
    await expect(
      page.getByText("共 25 条 · 每页 20 条", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(20);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator("tbody tr")).toHaveCount(5);
    await page.goto("/dashboard/logs?status=failed&group=group-b");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(
      page.getByText("UI audit record 23", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "查看", exact: true }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByText("UI upstream unavailable", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(20);
  });

  test("settings redact secrets and display schema metadata", async ({
    page,
  }) => {
    await page.goto("/dashboard/settings");
    await expect(
      page.getByText("数据库 Schema", { exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="badge"]').filter({ hasText: /^auto$/ })).toBeVisible();
    await expect(page.getByText("最近迁移时间", { exact: true })).toBeVisible();
    const text = await page.locator("body").innerText();
    for (const secret of [UI_SECRET, UI_TOKEN, UI_APP_ID])
      expect(text).not.toContain(secret);
    await page.getByRole("button", { name: "清空日志", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(
      dialog.getByRole("button", { name: "永久清空", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "test-results/settings-desktop.png",
      fullPage: true,
    });
  });

  test("approval rules persist as drafts and enabling unverified execution is rejected", async ({ page }) => {
    await page.goto('/dashboard/approval');
    await page.getByRole('button', { name: '新建规则', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('群 OpenID', { exact: true }).fill('ui-approval-group');
    await dialog.getByLabel('关键词', { exact: true }).fill('allow-ui');
    await dialog.getByLabel('测试申请内容 / 成员 OpenID', { exact: true }).fill('please allow-ui');
    await expect(dialog.getByText('匹配此规则，将通过申请（实际执行待联调）', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(dialog).toBeHidden();
    const row = page.locator('tbody tr').filter({ hasText: 'allow-ui' });
    await expect(row.getByText('草稿', { exact: true })).toBeVisible();
    const result = await (await page.request.get('/api/admin/policies')).json();
    const policy = result.policies.find((value: { rule_value: string }) => value.rule_value === 'allow-ui');
    expect(policy.enabled).toBe(false);
    const enable = await page.request.patch(`/api/admin/policies/${policy.id}`, { data: { enabled: true }, headers: { origin: APP_URL } });
    expect(enable.status()).toBe(501);
    const crossSite = await page.request.post('/api/admin/policies', { data: { group_openid: 'other', rule_type: 'keyword', rule_value: 'bad', action: 'approve' }, headers: { origin: 'https://invalid.example' } });
    expect(crossSite.status()).toBe(403);
    await page.reload();
    await expect(page.locator('tbody tr').filter({ hasText: 'allow-ui' }).getByText('草稿', { exact: true })).toBeVisible();
  });

  test("mobile navigation and command form remain usable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("link", { name: "指令管理", exact: true })
      .click();
    await expect(page).toHaveURL(/\/dashboard\/commands$/);
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByRole("button", { name: "新建指令", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("关键词", { exact: true }).fill("/mobile");
    await dialog.getByLabel("回复内容", { exact: true }).fill("Mobile reply");
    await dialog.getByLabel("保存前测试", { exact: true }).fill("/mobile");
    await expect(dialog.getByText("命中此指令", { exact: true })).toBeVisible();
    await page.screenshot({
      path: "test-results/command-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  });
});
