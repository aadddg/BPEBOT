import { test, expect } from '@playwright/test';
import { APP_URL } from './ui-server';

test('platform login exchanges a single-use code for a separate Bot cookie, then logout revokes it', async ({ page, context }) => {
  await context.addCookies([{ name: 'test-session', value: 'admin', url: 'http://localhost' }]);
  // A platform cookie alone must not authorize the Bot in SSO mode.
  expect((await page.request.get('/api/admin/state')).status()).toBe(401);
  await page.goto('/login');
  await page.getByRole('button', { name: '使用平台账号安全登录' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect((await page.request.get('/api/admin/state')).status()).toBe(200);
  const cookie = (await context.cookies()).find(value => value.name === '__Host-bpebot_session');
  expect(cookie).toBeTruthy(); expect(cookie!.httpOnly).toBe(true); expect(cookie!.secure).toBe(true); expect(cookie!.sameSite).toBe('Lax');
  expect((await context.cookies()).find(value => value.name === '__Host-bpebot_login')).toBeUndefined();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/admin/state')).status()).toBe(401);
  // Replaying a previously issued Bot cookie must fail after upstream revocation.
  await context.addCookies([cookie!]);
  expect((await page.request.get('/api/admin/state')).status()).toBe(401);
});

test('non-admin cannot obtain a Bot session through platform authorization', async ({ page, context }) => {
  await context.addCookies([{ name: 'test-session', value: 'member', url: 'http://localhost' }]);
  await page.goto('/login');
  await page.getByRole('button', { name: '使用平台账号安全登录' }).click();
  expect((await context.cookies()).find(value => value.name === '__Host-bpebot_session')).toBeUndefined();
  expect((await page.request.get(APP_URL + '/api/admin/state')).status()).toBe(401);
});
