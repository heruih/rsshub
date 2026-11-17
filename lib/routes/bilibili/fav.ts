import { config } from '@/config';
import type { Route } from '@/types';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import { getPlaywrightPage, type Page } from '@/utils/playwright';

import utils from './utils';

const favApiPath = '/x/v3/fav/resource/list';
const allowedBrowserRequestTypes = new Set(['document', 'script', 'xhr', 'fetch', 'image', 'font', 'stylesheet', 'other']);
// A Worker's remote browser session runs out of memory after about 30 seconds on a page stuck in
// Bilibili's risk control, so give up before that and return an error RSSHub can report.
const browserResponseTimeout = 20000;
const browserCloseTimeout = 90000;

type BrowserResponse = Awaited<ReturnType<Page['waitForResponse']>>;

const isFavApiResponse = (response: BrowserResponse) => {
    const request = response.request();
    return response.url().includes(favApiPath) && request.method() === 'GET' && (request.resourceType() === 'xhr' || request.resourceType() === 'fetch');
};

async function applyCookie(page: Page, cookie: string) {
    const cookies = cookie
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
            const equalIndex = item.indexOf('=');
            if (equalIndex <= 0) {
                return;
            }

            return {
                name: item.slice(0, equalIndex).trim(),
                value: item.slice(equalIndex + 1).trim(),
                domain: '.bilibili.com',
                path: '/',
            };
        })
        .filter((item) => item !== undefined);

    if (cookies.length > 0) {
        await page.context().addCookies(cookies);
    }
}

export const route: Route = {
    path: '/fav/:uid/:fid/:embed?',
    categories: ['social-media'],
    example: '/bilibili/fav/756508/50948568',
    parameters: { uid: '用户 id, 可在 UP 主主页中找到', fid: '收藏夹 ID, 可在收藏夹的 URL 中找到, 默认收藏夹建议使用 UP 主默认收藏夹功能', embed: '默认为开启内嵌视频, 任意值为关闭' },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: 'UP 主非默认收藏夹',
    maintainers: ['Qixingchen'],
    handler,
};

async function handler(ctx) {
    const fid = ctx.req.param('fid');
    const uid = ctx.req.param('uid');
    const embed = !ctx.req.param('embed');

    const cookie = config.bilibili.cookies[uid];
    const favUrl = `https://space.bilibili.com/${uid}/favlist?fid=${fid}`;
    logger.info(`[bilibili/fav] fetching via playwright: ${favUrl}`);

    const { destroy, page } = await getPlaywrightPage(favUrl, {
        closeTimeout: browserCloseTimeout,
        noGoto: true,
        onBeforeLoad: async (page) => {
            await utils.disableAutoTranslate(page);
            if (cookie) {
                await applyCookie(page, cookie);
            }

            await page.route('**/*', (route) => {
                const request = route.request();
                allowedBrowserRequestTypes.has(request.resourceType()) ? route.continue() : route.abort();
            });
        },
        gotoConfig: { waitUntil: 'domcontentloaded' },
    });

    let data;
    try {
        const responsePromise = page.waitForResponse(isFavApiResponse, { timeout: browserResponseTimeout });
        try {
            await page.goto(favUrl, { timeout: browserResponseTimeout, waitUntil: 'domcontentloaded' });
        } catch (error) {
            logger.warn(`[bilibili/fav] fav page navigation did not finish before the response wait ended: ${error instanceof Error ? error.message : String(error)}`);
        }

        const response = await responsePromise;
        if (response.status() !== 200) {
            throw new Error(`Bilibili browser mode returned unexpected fav API status ${response.status()}`);
        }

        const contentType = response.headers()['content-type'];
        if (!contentType?.includes('application/json')) {
            throw new Error(`Bilibili browser mode returned non-JSON response with status ${response.status()}; BILIBILI_COOKIE_* may be required`);
        }

        const json = await response.json();
        if (json.code) {
            throw new Error(json.message ?? json.code);
        }

        data = json.data;
    } finally {
        await destroy();
    }

    const username = data.info.upper.name;
    const favName = data.info.title;

    return {
        title: `${username} 的 bilibili 收藏夹 ${favName}`,
        link: `https://space.bilibili.com/${uid}/#/favlist?fid=${fid}`,
        description: `${username} 的 bilibili 收藏夹 ${favName}`,

        item:
            data.medias &&
            data.medias.map((item) => ({
                title: item.title,
                description: utils.renderUGCDescription(embed, item.cover, item.intro, item.id, undefined, item.bvid),
                pubDate: parseDate(item.fav_time * 1000),
                link: item.fav_time > utils.bvidTime && item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : `https://www.bilibili.com/video/av${item.id}`,
                author: item.upper.name,
            })),
    };
}
