/**
 * Cloudflare Workers 反向代理 - Claude AI 中转站加速
 * 目标地址: https://anyrouter.top
 *
 * 功能特性：
 * - 🌏 智能路由：国内访问 → Cloudflare国内节点 → Cloudflare海外节点 → anyrouter.top
 * - 🚀 强制海外出口：绕过 GFW，确保国内用户可访问被墙站点
 * - 📍 地理位置检测：自动识别中国大陆/港澳台访问者
 * - 💾 智能缓存（静态资源和 GET 请求）
 * - 🌊 流式传输支持（SSE for Claude AI）
 * - 🔄 自动重试机制
 * - ⚡ 性能优化（Keep-Alive、超时控制）
 * - 🔐 完整的 CORS 支持
 * - 📝 错误处理和详细日志记录
 *
 * 路由工作原理：
 * 1. 用户访问 Worker 域名，Cloudflare 自动解析到最近的边缘节点（国内用户 → 国内节点）
 * 2. Worker 检测用户地理位置（通过 request.cf.country）
 * 3. 如果来自中国且启用 forceInternationalEgress，则配置 cf 参数强制使用海外出口
 * 4. 请求通过 Cloudflare 全球骨干网络路由到海外节点，再访问目标站点
 * 5. 这样即使目标站点在国内被墙，用户也能正常访问
 */

// 配置项
const CONFIG = {
  // 目标中转站地址（多镜像支持，按优先级排序）
  targetUrls: [
    'https://anyrouter.top',                                 // 主站点（优先）
    'https://c.cspok.cn',                                    // 备用镜像 1
    'https://pmpjfbhq.cn-nb1.rainapp.top',                   // 备用镜像 2
    'https://a-ocnfniawgw.cn-shanghai.fcapp.run',            // 备用镜像 3
  ],

  // 允许的请求方法
  allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],

  // 路由配置：强制使用海外节点
  routing: {
    // 强制通过 Cloudflare 海外节点访问目标（绕过国内 GFW）
    forceInternationalEgress: true,
    // 国内访问者检测（通过 Cloudflare 提供的地理位置信息）
    chinaRegions: ['CN', 'HK', 'MO', 'TW'],
  },

  // 镜像切换配置
  mirror: {
    // 是否启用自动故障转移
    autoFailover: true,
    // 单个镜像的超时时间（毫秒）
    singleMirrorTimeout: 10000,
    // 触发切换的 HTTP 状态码
    failoverStatuses: [502, 503, 504, 521, 522, 523, 524],
  },

  // 缓存配置
  cache: {
    // GET 请求缓存时间（秒）
    defaultTtl: 300,
    // 静态资源缓存时间（秒）
    staticTtl: 86400,
    // 静态资源文件扩展名
    staticExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.css', '.js', '.woff', '.woff2', '.ttf', '.ico'],
  },

  // 重试配置
  retry: {
    maxRetries: 2,
    retryDelay: 1000, // 毫秒
    retryableStatuses: [502, 503, 504],
  },

  // 请求超时配置（毫秒）
  timeout: {
    // 总超时时间（包括所有重试）
    total: 60000,
    // 单次请求超时
    singleRequest: 30000,
    // 连接超时（首字节超时）
    connect: 10000,
  },

  // 调试配置
  debug: {
    enabled: true, // 开启详细日志
    logLevel: 'INFO', // 日志级别: ERROR, WARN, INFO, DEBUG
    logRequestBody: false, // 记录请求体（仅 DEBUG 级别，生产环境建议关闭）
    logResponseBody: false, // 记录响应体（仅 DEBUG 级别，生产环境建议关闭）
    logRouting: true, // 记录路由信息
  },

  // 镜像选择策略
  mirrorStrategy: 'primary-first', // 'sequential' | 'race' | 'primary-first'
  // sequential: 串行尝试，失败后切换（省token但慢）
  // race: 同时请求所有镜像，使用最快响应（快但消耗token）
  // primary-first: 优先主站点，失败后并发所有备用镜像（推荐，平衡性能和token消耗）

  // 镜像健康检查
  healthCheck: {
    enabled: true,
    // 失败阈值：连续失败 N 次后标记为不健康
    failureThreshold: 3,
    // 熔断时间：不健康镜像的冷却时间（秒）
    cooldownPeriod: 600, // 10 分钟
  },
};

// 需要移除的请求头
const HEADERS_TO_REMOVE = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'x-forwarded-proto',
  'x-real-ip',
];

// 镜像健康状态（内存存储，重启后重置）
const MIRROR_HEALTH = new Map();

// 日志级别定义
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

/**
 * 分级日志函数
 * @param {string} level - 日志级别
 * @param {string} message - 日志消息
 * @param  {...any} args - 额外参数
 */
function log(level, message, ...args) {
  if (!CONFIG.debug.enabled) return;

  const currentLevel = LOG_LEVELS[CONFIG.debug.logLevel] || LOG_LEVELS.INFO;
  const messageLevel = LOG_LEVELS[level] || LOG_LEVELS.INFO;

  if (messageLevel <= currentLevel) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}]`;
    console.log(prefix, message, ...args);
  }
}

/**
 * 获取镜像健康状态
 * @param {string} mirrorUrl - 镜像地址
 */
function getMirrorHealth(mirrorUrl) {
  if (!CONFIG.healthCheck.enabled) {
    return { healthy: true, failures: 0, lastCheck: null };
  }

  if (!MIRROR_HEALTH.has(mirrorUrl)) {
    MIRROR_HEALTH.set(mirrorUrl, {
      healthy: true,
      failures: 0,
      lastCheck: null,
      cooldownUntil: null,
    });
  }

  return MIRROR_HEALTH.get(mirrorUrl);
}

/**
 * 更新镜像健康状态
 * @param {string} mirrorUrl - 镜像地址
 * @param {boolean} success - 请求是否成功
 */
function updateMirrorHealth(mirrorUrl, success) {
  if (!CONFIG.healthCheck.enabled) return;

  const health = getMirrorHealth(mirrorUrl);
  health.lastCheck = Date.now();

  if (success) {
    // 成功则重置失败计数
    health.failures = 0;
    health.healthy = true;
    health.cooldownUntil = null;
    log('DEBUG', `镜像 ${mirrorUrl} 健康状态恢复`);
  } else {
    // 失败则增加计数
    health.failures++;
    log('WARN', `镜像 ${mirrorUrl} 失败次数: ${health.failures}`);

    // 超过阈值标记为不健康
    if (health.failures >= CONFIG.healthCheck.failureThreshold) {
      health.healthy = false;
      health.cooldownUntil = Date.now() + (CONFIG.healthCheck.cooldownPeriod * 1000);
      log('ERROR', `镜像 ${mirrorUrl} 已标记为不健康，冷却至 ${new Date(health.cooldownUntil).toISOString()}`);
    }
  }

  MIRROR_HEALTH.set(mirrorUrl, health);
}

/**
 * 检查镜像是否可用
 * @param {string} mirrorUrl - 镜像地址
 */
function isMirrorAvailable(mirrorUrl) {
  if (!CONFIG.healthCheck.enabled) return true;

  const health = getMirrorHealth(mirrorUrl);

  // 如果在冷却期，检查是否已过期
  if (!health.healthy && health.cooldownUntil) {
    if (Date.now() > health.cooldownUntil) {
      // 冷却期结束，重置状态
      health.healthy = true;
      health.failures = 0;
      health.cooldownUntil = null;
      MIRROR_HEALTH.set(mirrorUrl, health);
      log('INFO', `镜像 ${mirrorUrl} 冷却期结束，重新启用`);
      return true;
    }
    return false;
  }

  return health.healthy;
}

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();

    try {
      // 获取客户端地理位置信息（Cloudflare 自动提供）
      const clientCountry = request.cf?.country || 'UNKNOWN';
      const clientRegion = request.cf?.region || 'UNKNOWN';
      const clientCity = request.cf?.city || 'UNKNOWN';
      const isFromChina = CONFIG.routing.chinaRegions.includes(clientCountry);

      // 调试日志：客户端信息
      if (CONFIG.debug.enabled && CONFIG.debug.logRouting) {
        log('INFO', '=== 客户端地理位置信息 ===');
        log('INFO', '国家/地区:', clientCountry);
        log('INFO', '省份/州:', clientRegion);
        log('INFO', '城市:', clientCity);
        log('INFO', '是否来自中国大陆/港澳台:', isFromChina);
        log('INFO', '路由策略:', CONFIG.routing.forceInternationalEgress ? '强制海外出口' : '自动选择');
      }

      // 诊断端点：用于测试代理是否正常工作
      const url = new URL(request.url);
      if (url.pathname === '/_health' || url.pathname === '/health') {
        return new Response(JSON.stringify({
          status: 'ok',
          message: 'Cloudflare Claude 代理服务运行正常',
          targetUrls: CONFIG.targetUrls,
          primaryTarget: CONFIG.targetUrls[0],
          timestamp: new Date().toISOString(),
          debug: CONFIG.debug.enabled,
          routing: {
            forceInternationalEgress: CONFIG.routing.forceInternationalEgress,
            clientCountry,
            clientRegion,
            clientCity,
            isFromChina,
          },
          mirror: {
            autoFailover: CONFIG.mirror.autoFailover,
            totalMirrors: CONFIG.targetUrls.length,
          },
          cloudflare: {
            colo: request.cf?.colo || 'UNKNOWN',  // Cloudflare 数据中心代码
            asn: request.cf?.asn || 'UNKNOWN',    // 自治系统编号
            timezone: request.cf?.timezone || 'UNKNOWN',
          },
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...getCORSHeaders(),
          },
        });
      }

      // 连接测试端点：测试所有镜像的可达性
      if (url.pathname === '/_test' || url.pathname === '/test') {
        const mirrorTests = [];

        for (let i = 0; i < CONFIG.targetUrls.length; i++) {
          const targetUrl = CONFIG.targetUrls[i];
          const isPrimary = i === 0;

          try {
            const testStart = Date.now();
            const testResponse = await fetch(targetUrl, {
              method: 'HEAD',
              signal: AbortSignal.timeout(CONFIG.mirror.singleMirrorTimeout),
              cf: {
                cacheTtl: -1,
                ...(isFromChina && CONFIG.routing.forceInternationalEgress ? {
                  mirage: false,
                  polish: 'off',
                } : {}),
              },
            });
            const testDuration = Date.now() - testStart;

            mirrorTests.push({
              url: targetUrl,
              status: 'success',
              isPrimary,
              priority: i + 1,
              httpStatus: testResponse.status,
              duration: `${testDuration}ms`,
              reachable: testResponse.ok,
            });
          } catch (error) {
            mirrorTests.push({
              url: targetUrl,
              status: 'failed',
              isPrimary,
              priority: i + 1,
              error: error.message,
              reachable: false,
            });
          }
        }

        const anyReachable = mirrorTests.some(t => t.reachable);
        const primaryReachable = mirrorTests[0]?.reachable || false;

        return new Response(JSON.stringify({
          status: anyReachable ? 'success' : 'failed',
          message: anyReachable
            ? (primaryReachable ? '主站点可达' : '主站点不可达，但备用镜像可用')
            : '所有镜像均不可达',
          mirrors: mirrorTests,
          client: {
            country: clientCountry,
            region: clientRegion,
            city: clientCity,
            isFromChina,
          },
          worker: {
            colo: request.cf?.colo || 'UNKNOWN',
            coloLocation: getColoLocation(request.cf?.colo),
          },
          recommendation: primaryReachable
            ? '✅ 主站点运行正常'
            : (anyReachable ? '⚠️ 建议使用备用镜像或检查网络' : '❌ 所有站点均不可达，请检查 Worker 节点位置'),
          timestamp: new Date().toISOString(),
        }), {
          status: anyReachable ? 200 : 500,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...getCORSHeaders(),
          },
        });
      }

      // 处理 CORS 预检请求
      if (request.method === 'OPTIONS') {
        return handleCORS(request);
      }

      // 检查请求方法
      if (!CONFIG.allowedMethods.includes(request.method)) {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: getCORSHeaders(),
        });
      }

      // 尝试从缓存获取（仅 GET 和 HEAD 请求）
      if (request.method === 'GET' || request.method === 'HEAD') {
        try {
          const cache = caches.default;
          const cachedResponse = await cache.match(request);

          if (cachedResponse) {
            const response = new Response(cachedResponse.body, cachedResponse);
            response.headers.set('X-Cache-Status', 'HIT');
            response.headers.set('X-Response-Time', `${Date.now() - startTime}ms`);
            log('INFO', '缓存命中:', request.url);
            return response;
          }
        } catch (cacheError) {
          // 缓存读取失败不应阻止请求，记录错误后继续
          log('ERROR', '缓存读取失败:', cacheError.message);
          log('DEBUG', '继续处理原始请求');
        }
      }

      // 执行代理请求（带多镜像故障转移）
      const response = await proxyRequestWithMirrorFailover(request, isFromChina);

      // 添加性能和缓存标识头
      response.headers.set('X-Cache-Status', 'MISS');
      response.headers.set('X-Response-Time', `${Date.now() - startTime}ms`);
      response.headers.set('X-Proxy-By', 'Cloudflare-Workers');
      response.headers.set('X-Client-Country', clientCountry);
      response.headers.set('X-Routing-Via', isFromChina && CONFIG.routing.forceInternationalEgress ? 'International-Egress' : 'Auto');

      // 对可缓存的响应进行缓存
      if (shouldCache(request, response)) {
        const cacheResponse = response.clone();
        ctx.waitUntil(cacheWithTTL(request, cacheResponse));
      }

      return response;

    } catch (error) {
      log('ERROR', '=== 代理错误 ===');
      log('ERROR', '错误类型:', error.name);
      log('ERROR', '错误消息:', error.message);
      log('ERROR', '错误堆栈:', error.stack);
      log('ERROR', '请求 URL:', request.url);
      log('ERROR', '请求方法:', request.method);

      // 构建详细的错误响应
      const errorResponse = {
        error: '代理请求失败',
        message: error.message || '内部服务器错误',
        details: {
          errorType: error.name,
          targetUrls: CONFIG.targetUrls,
          primaryTarget: CONFIG.targetUrls[0],
          requestUrl: request.url,
          requestMethod: request.method,
        },
        timestamp: new Date().toISOString(),
        responseTime: `${Date.now() - startTime}ms`,
      };

      // 如果是超时错误，提供更明确的信息
      if (error.name === 'AbortError') {
        errorResponse.message = '请求超时：目标服务器响应时间过长';
        errorResponse.details.timeout = `${CONFIG.timeout.singleRequest}ms`;
      }

      return new Response(
        JSON.stringify(errorResponse, null, 2),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...getCORSHeaders(),
          },
        }
      );
    }
  },
};

/**
 * 多镜像故障转移代理请求
 * @param {Request} request - 原始请求
 * @param {boolean} isFromChina - 是否来自中国大陆/港澳台
 */
async function proxyRequestWithMirrorFailover(request, isFromChina = false) {
  // 根据配置选择镜像策略
  if (CONFIG.mirrorStrategy === 'race') {
    return proxyRequestRaceMode(request, isFromChina);
  } else if (CONFIG.mirrorStrategy === 'primary-first') {
    return proxyRequestPrimaryFirstMode(request, isFromChina);
  } else {
    return proxyRequestSequentialMode(request, isFromChina);
  }
}

/**
 * Primary-First 模式：优先尝试主站点，失败后并发所有备用镜像
 * @param {Request} request - 原始请求
 * @param {boolean} isFromChina - 是否来自中国大陆/港澳台
 */
async function proxyRequestPrimaryFirstMode(request, isFromChina = false) {
  const primaryMirror = CONFIG.targetUrls[0];
  const backupMirrors = CONFIG.targetUrls.slice(1);

  log('INFO', '=== Primary-First 模式：优先主站点 ===');
  log('INFO', '主站点:', primaryMirror);
  log('INFO', '备用镜像数量:', backupMirrors.length);

  // 第一步：尝试主站点
  if (isMirrorAvailable(primaryMirror)) {
    try {
      log('INFO', '正在尝试主站点...');
      const primaryResponse = await proxyRequestWithRetry(request.clone(), isFromChina, primaryMirror, 0);

      // 检查响应状态是否需要故障转移
      if (!CONFIG.mirror.autoFailover || !CONFIG.mirror.failoverStatuses.includes(primaryResponse.status)) {
        // 主站点成功
        updateMirrorHealth(primaryMirror, true);
        log('INFO', '✓ 主站点响应成功');

        const modifiedResponse = new Response(primaryResponse.body, primaryResponse);
        modifiedResponse.headers.set('X-Mirror-Used', primaryMirror);
        modifiedResponse.headers.set('X-Mirror-Index', '1');
        modifiedResponse.headers.set('X-Mirror-Priority', 'primary');
        modifiedResponse.headers.set('X-Mirror-Strategy', 'primary-first');

        return modifiedResponse;
      } else {
        // 主站点返回错误状态码
        log('WARN', `主站点返回错误状态 ${primaryResponse.status}，切换到备用镜像`);
        updateMirrorHealth(primaryMirror, false);
      }
    } catch (error) {
      // 主站点请求失败
      log('WARN', `主站点请求失败: ${error.message}`);
      updateMirrorHealth(primaryMirror, false);
    }
  } else {
    log('WARN', '主站点不健康，跳过');
  }

  // 第二步：主站点失败，并发所有备用镜像
  if (backupMirrors.length === 0) {
    throw new Error('主站点失败且无备用镜像可用');
  }

  log('INFO', `主站点不可用，并发请求 ${backupMirrors.length} 个备用镜像...`);

  // 过滤出可用的备用镜像
  const availableBackups = backupMirrors.filter((url, index) => {
    const available = isMirrorAvailable(url);
    if (!available) {
      log('WARN', `备用镜像 ${index + 2} (${url}) 不健康，跳过`);
    }
    return available;
  });

  if (availableBackups.length === 0) {
    log('WARN', '所有备用镜像不健康，尝试使用所有镜像');
    availableBackups.push(...backupMirrors);
  }

  // 并发请求所有可用的备用镜像
  const backupPromises = availableBackups.map((targetUrl) => {
    return proxyRequestWithRetry(request.clone(), isFromChina, targetUrl, 0)
      .then(response => {
        updateMirrorHealth(targetUrl, true);

        const mirrorIndex = CONFIG.targetUrls.indexOf(targetUrl);
        log('INFO', `✓ 备用镜像 ${mirrorIndex + 1} 响应成功 (${targetUrl})`);

        const modifiedResponse = new Response(response.body, response);
        modifiedResponse.headers.set('X-Mirror-Used', targetUrl);
        modifiedResponse.headers.set('X-Mirror-Index', String(mirrorIndex + 1));
        modifiedResponse.headers.set('X-Mirror-Priority', 'backup');
        modifiedResponse.headers.set('X-Mirror-Strategy', 'primary-first');

        return { success: true, response: modifiedResponse, mirror: targetUrl };
      })
      .catch(error => {
        updateMirrorHealth(targetUrl, false);
        const mirrorIndex = CONFIG.targetUrls.indexOf(targetUrl);
        log('WARN', `备用镜像 ${mirrorIndex + 1} (${targetUrl}) 请求失败: ${error.message}`);
        return { success: false, error: error.message, mirror: targetUrl };
      });
  });

  try {
    // 使用 Promise.race 获取第一个完成的备用镜像
    const result = await Promise.race(backupPromises);

    if (result.success) {
      return result.response;
    }

    // 第一个响应失败，等待其他备用镜像
    log('WARN', '第一个备用镜像响应失败，等待其他镜像');
    const allResults = await Promise.allSettled(backupPromises);

    // 查找第一个成功的响应
    for (const settledResult of allResults) {
      if (settledResult.status === 'fulfilled' && settledResult.value.success) {
        return settledResult.value.response;
      }
    }

    // 所有备用镜像都失败
    log('ERROR', `所有镜像（包括主站点和 ${availableBackups.length} 个备用镜像）均失败`);
    throw new Error(`所有镜像均不可达。主站点和 ${availableBackups.length} 个备用镜像都失败了`);

  } catch (error) {
    log('ERROR', 'Primary-First 模式请求失败:', error.message);
    throw error;
  }
}

/**
 * Race 模式：并行请求多个镜像，使用最快响应
 * @param {Request} request - 原始请求
 * @param {boolean} isFromChina - 是否来自中国大陆/港澳台
 */
async function proxyRequestRaceMode(request, isFromChina = false) {
  log('INFO', `=== Race 模式：并行请求 ${CONFIG.targetUrls.length} 个镜像 ===`);

  // 过滤出可用的镜像
  const availableMirrors = CONFIG.targetUrls.filter((url, index) => {
    const available = isMirrorAvailable(url);
    if (!available) {
      log('WARN', `镜像 ${index + 1} (${url}) 不健康，跳过`);
    }
    return available;
  });

  if (availableMirrors.length === 0) {
    log('ERROR', '所有镜像均不可用，尝试所有镜像');
    // 如果所有镜像都不健康，仍然尝试所有镜像（可能已过冷却期）
    availableMirrors.push(...CONFIG.targetUrls);
  }

  log('INFO', `可用镜像数量: ${availableMirrors.length}`);

  // 为每个镜像创建请求 Promise
  const racePromises = availableMirrors.map((targetUrl, index) => {
    return proxyRequestWithRetry(request.clone(), isFromChina, targetUrl, 0)
      .then(response => {
        // 成功响应
        updateMirrorHealth(targetUrl, true);

        const mirrorIndex = CONFIG.targetUrls.indexOf(targetUrl);
        const isPrimary = mirrorIndex === 0;

        log('INFO', `✓ 镜像 ${mirrorIndex + 1} 响应成功 (${targetUrl})`);

        // 添加镜像信息头
        const modifiedResponse = new Response(response.body, response);
        modifiedResponse.headers.set('X-Mirror-Used', targetUrl);
        modifiedResponse.headers.set('X-Mirror-Index', String(mirrorIndex + 1));
        modifiedResponse.headers.set('X-Mirror-Priority', isPrimary ? 'primary' : 'backup');
        modifiedResponse.headers.set('X-Mirror-Strategy', 'race');

        return { success: true, response: modifiedResponse, mirror: targetUrl };
      })
      .catch(error => {
        // 失败响应
        updateMirrorHealth(targetUrl, false);
        log('WARN', `镜像 ${index + 1} (${targetUrl}) 请求失败: ${error.message}`);
        return { success: false, error: error.message, mirror: targetUrl };
      });
  });

  try {
    // Promise.race 返回第一个完成的 Promise（无论成功还是失败）
    // 我们需要第一个成功的响应
    const result = await Promise.race(racePromises);

    if (result.success) {
      return result.response;
    }

    // 如果第一个响应失败，等待其他响应
    log('WARN', '第一个响应失败，等待其他镜像');
    const allResults = await Promise.allSettled(racePromises);

    // 查找第一个成功的响应
    for (const settledResult of allResults) {
      if (settledResult.status === 'fulfilled' && settledResult.value.success) {
        return settledResult.value.response;
      }
    }

    // 所有镜像都失败
    const errors = allResults
      .filter(r => r.status === 'fulfilled' && !r.value.success)
      .map(r => r.value);

    log('ERROR', `所有 ${availableMirrors.length} 个镜像均失败`);
    throw new Error(`所有镜像均不可达。尝试了 ${availableMirrors.length} 个镜像`);

  } catch (error) {
    log('ERROR', 'Race 模式请求失败:', error.message);
    throw error;
  }
}

/**
 * Sequential 模式：串行尝试镜像，失败后切换
 * @param {Request} request - 原始请求
 * @param {boolean} isFromChina - 是否来自中国大陆/港澳台
 */
async function proxyRequestSequentialMode(request, isFromChina = false) {
  const errors = [];

  // 遍历所有镜像地址
  for (let mirrorIndex = 0; mirrorIndex < CONFIG.targetUrls.length; mirrorIndex++) {
    const currentTargetUrl = CONFIG.targetUrls[mirrorIndex];
    const isPrimary = mirrorIndex === 0;

    // 检查镜像是否可用
    if (!isMirrorAvailable(currentTargetUrl)) {
      log('WARN', `镜像 ${mirrorIndex + 1} (${currentTargetUrl}) 不健康，跳过`);
      errors.push({ mirror: currentTargetUrl, error: '镜像不健康，在冷却期', skipped: true });
      continue;
    }

    try {
      log('INFO', `=== 尝试镜像 ${mirrorIndex + 1}/${CONFIG.targetUrls.length} ===`);
      log('DEBUG', '镜像地址:', currentTargetUrl);
      log('DEBUG', '优先级:', isPrimary ? '主站点' : `备用镜像 ${mirrorIndex}`);

      // 使用当前镜像发起请求（带重试）
      const response = await proxyRequestWithRetry(request.clone(), isFromChina, currentTargetUrl, 0);

      // 检查响应状态是否需要故障转移
      if (CONFIG.mirror.autoFailover && CONFIG.mirror.failoverStatuses.includes(response.status)) {
        const errorMsg = `镜像 ${mirrorIndex + 1} 返回错误状态 ${response.status}`;
        log('WARN', errorMsg);
        errors.push({ mirror: currentTargetUrl, error: errorMsg, status: response.status });
        updateMirrorHealth(currentTargetUrl, false);

        // 如果不是最后一个镜像，继续尝试下一个
        if (mirrorIndex < CONFIG.targetUrls.length - 1) {
          log('INFO', '切换到下一个镜像...');
          continue;
        }
      }

      // 成功响应
      updateMirrorHealth(currentTargetUrl, true);

      const modifiedResponse = new Response(response.body, response);
      modifiedResponse.headers.set('X-Mirror-Used', currentTargetUrl);
      modifiedResponse.headers.set('X-Mirror-Index', String(mirrorIndex + 1));
      modifiedResponse.headers.set('X-Mirror-Priority', isPrimary ? 'primary' : 'backup');
      modifiedResponse.headers.set('X-Mirror-Strategy', 'sequential');

      log('INFO', `✓ 镜像 ${mirrorIndex + 1} 响应成功`);

      return modifiedResponse;

    } catch (error) {
      const errorMsg = `镜像 ${mirrorIndex + 1} 请求失败: ${error.message}`;
      log('ERROR', errorMsg);
      errors.push({ mirror: currentTargetUrl, error: errorMsg, type: error.name });
      updateMirrorHealth(currentTargetUrl, false);

      // 如果是最后一个镜像，抛出错误
      if (mirrorIndex === CONFIG.targetUrls.length - 1) {
        log('ERROR', '=== 所有镜像均失败 ===');
        errors.forEach((e, i) => {
          log('ERROR', `镜像 ${i + 1}:`, e.mirror, '-', e.error);
        });

        // 返回详细的错误信息
        const detailedError = new Error(`所有镜像均不可达。尝试了 ${CONFIG.targetUrls.length} 个镜像`);
        detailedError.mirrorErrors = errors;
        throw detailedError;
      }

      // 继续尝试下一个镜像
      log('INFO', `切换到镜像 ${mirrorIndex + 2}...`);
    }
  }

  // 理论上不应该到这里
  throw new Error('镜像故障转移逻辑异常');
}

/**
 * 带重试机制的代理请求
 * @param {Request} request - 原始请求
 * @param {boolean} isFromChina - 是否来自中国大陆/港澳台
 * @param {string} targetUrlString - 目标镜像地址
 * @param {number} retryCount - 重试次数
 */
async function proxyRequestWithRetry(request, isFromChina = false, targetUrlString, retryCount = 0) {
  try {
    // 构建目标 URL
    const url = new URL(request.url);
    const targetUrl = new URL(targetUrlString);
    targetUrl.pathname = url.pathname;
    targetUrl.search = url.search;

    // 调试日志：记录请求信息
    if (CONFIG.debug.enabled) {
      log('DEBUG', '=== 代理请求开始 ===');
      log('DEBUG', '请求方法:', request.method);
      log('DEBUG', '原始 URL:', request.url);
      log('DEBUG', '目标 URL:', targetUrl.toString());
      log('DEBUG', '重试次数:', retryCount);
      log('DEBUG', '来自中国:', isFromChina);
    }

    // 构建请求头
    const headers = buildProxyHeaders(request, targetUrlString);

    // 调试日志：记录请求头
    if (CONFIG.debug.enabled) {
      log('DEBUG', '请求头:', Object.fromEntries(headers.entries()));
    }

    // 构建请求配置
    const proxyInit = {
      method: request.method,
      headers: headers,
      // 启用 Cloudflare 加速特性和路由优化
      cf: {
        // 禁用 Cloudflare 自动缓存，使用自定义缓存逻辑
        cacheTtl: -1,
        cacheEverything: false,
        cacheLevel: 'basic',

        // 关键配置：强制使用海外节点（绕过 GFW）
        // 当用户来自中国且启用了强制海外出口时，确保请求通过海外节点
        ...(isFromChina && CONFIG.routing.forceInternationalEgress ? {
          // 禁用中国大陆优化，强制使用国际路由
          mirage: false,
          polish: 'off',
          // 使用 Cloudflare 的全球骨干网络
          minify: {
            javascript: false,
            css: false,
            html: false,
          },
        } : {}),
      },
    };

    // 处理请求体（POST/PUT/PATCH）
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      const contentType = request.headers.get('content-type') || '';

      log('DEBUG', 'Content-Type:', contentType);

      // 检查是否是流式请求（SSE）
      if (contentType.includes('text/event-stream') || contentType.includes('application/stream')) {
        // 流式请求直接传递 body
        proxyInit.body = request.body;
        log('DEBUG', '检测到流式请求，直接传递 body');
      } else {
        // 非流式请求
        // 优化：仅在需要记录日志时才读取请求体，否则直接传递
        if (CONFIG.debug.logRequestBody && LOG_LEVELS[CONFIG.debug.logLevel] >= LOG_LEVELS.DEBUG) {
          try {
            const clonedRequest = request.clone();
            const bodyText = await clonedRequest.text();

            log('DEBUG', '请求体长度:', bodyText.length);
            log('DEBUG', '请求体内容:', bodyText.substring(0, 500)); // 只显示前500字符

            // 重新赋值请求体
            proxyInit.body = bodyText;
          } catch (bodyError) {
            log('ERROR', '读取请求体失败:', bodyError.message);
            // 降级方案：使用原始 body
            proxyInit.body = request.body;
          }
        } else {
          // 生产环境直接传递 body，不读取到内存
          proxyInit.body = request.body;
        }
      }
    }

    // 发送请求（带超时控制）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout.singleRequest);

    log('DEBUG', '发送请求到目标服务器...');

    const response = await fetch(targetUrl.toString(), {
      ...proxyInit,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // 调试日志：记录响应信息
    if (CONFIG.debug.enabled) {
      log('DEBUG', '=== 收到响应 ===');
      log('DEBUG', '响应状态:', response.status, response.statusText);
      log('DEBUG', '响应头:', Object.fromEntries(response.headers.entries()));
    }

    // 检查是否需要重试
    if (
      CONFIG.retry.retryableStatuses.includes(response.status) &&
      retryCount < CONFIG.retry.maxRetries
    ) {
      log('WARN', `服务器返回 ${response.status}，重试中 (${retryCount + 1}/${CONFIG.retry.maxRetries})...`);
      await sleep(CONFIG.retry.retryDelay);
      return proxyRequestWithRetry(request, isFromChina, targetUrlString, retryCount + 1);
    }

    // 调试日志：路由成功
    if (CONFIG.debug.enabled && CONFIG.debug.logRouting) {
      log('INFO', '=== 路由成功 ===');
      log('INFO', '使用海外节点:', isFromChina && CONFIG.routing.forceInternationalEgress);
      log('INFO', '响应状态:', response.status);
    }

    // 构建响应
    return buildProxyResponse(response);

  } catch (error) {
    log('ERROR', '代理请求异常:', error.message);
    log('DEBUG', '错误堆栈:', error.stack);

    // 重试逻辑
    if (retryCount < CONFIG.retry.maxRetries) {
      log('INFO', `请求失败，重试中 (${retryCount + 1}/${CONFIG.retry.maxRetries})...`);
      await sleep(CONFIG.retry.retryDelay);
      return proxyRequestWithRetry(request, isFromChina, targetUrlString, retryCount + 1);
    }

    throw error;
  }
}

/**
 * 构建代理请求头
 * @param {Request} request - 原始请求
 * @param {string} targetUrlString - 目标镜像地址
 */
function buildProxyHeaders(request, targetUrlString) {
  const headers = new Headers(request.headers);

  // 移除 Cloudflare 特定头
  HEADERS_TO_REMOVE.forEach(header => headers.delete(header));

  // 设置目标主机
  const targetUrl = new URL(targetUrlString);
  headers.set('Host', targetUrl.host);

  // 保留客户端真实 IP
  const clientIP = request.headers.get('cf-connecting-ip');
  if (clientIP) {
    const existingXFF = headers.get('X-Forwarded-For');
    headers.set('X-Forwarded-For', existingXFF ? `${existingXFF}, ${clientIP}` : clientIP);
    headers.set('X-Real-IP', clientIP);
  }

  // 设置连接优化头
  headers.set('Connection', 'keep-alive');

  // 确保接受编码
  if (!headers.has('Accept-Encoding')) {
    headers.set('Accept-Encoding', 'gzip, deflate, br');
  }

  return headers;
}

/**
 * 构建代理响应
 */
async function buildProxyResponse(response) {
  // 检查是否是流式响应（SSE）
  const contentType = response.headers.get('content-type') || '';
  const isStream = contentType.includes('text/event-stream') ||
                   contentType.includes('application/stream+json');

  // 调试日志：记录响应类型
  if (CONFIG.debug.enabled) {
    log('DEBUG', '响应类型:', isStream ? '流式响应' : '普通响应');
    log('DEBUG', 'Content-Type:', contentType);
  }

  // 对于非流式响应，记录响应体（用于调试）
  let responseBody = response.body;
  if (CONFIG.debug.logResponseBody && !isStream && LOG_LEVELS[CONFIG.debug.logLevel] >= LOG_LEVELS.DEBUG) {
    try {
      const clonedResponse = response.clone();
      const bodyText = await clonedResponse.text();
      log('DEBUG', '响应体长度:', bodyText.length);
      log('DEBUG', '响应体内容:', bodyText.substring(0, 500)); // 只显示前500字符

      // 尝试解析 JSON 验证格式
      try {
        const jsonBody = JSON.parse(bodyText);
        log('DEBUG', '响应体 JSON 解析成功');
        log('DEBUG', 'JSON 键:', Object.keys(jsonBody));
      } catch (jsonError) {
        log('DEBUG', '响应体不是有效的 JSON 格式');
      }
    } catch (logError) {
      log('ERROR', '记录响应体时出错:', logError.message);
    }
  }

  // 创建新响应
  const modifiedResponse = new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  // 添加 CORS 头
  const corsHeaders = getCORSHeaders();
  Object.entries(corsHeaders).forEach(([key, value]) => {
    modifiedResponse.headers.set(key, value);
  });

  // 移除可能导致问题的安全头
  modifiedResponse.headers.delete('Content-Security-Policy');
  modifiedResponse.headers.delete('X-Frame-Options');

  // 对于流式响应，确保不被缓存
  if (isStream) {
    modifiedResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    modifiedResponse.headers.set('X-Accel-Buffering', 'no');
  }

  log('DEBUG', '=== 代理响应构建完成 ===');

  return modifiedResponse;
}

/**
 * 判断是否应该缓存
 */
function shouldCache(request, response) {
  // 只缓存 GET 请求
  if (request.method !== 'GET') {
    return false;
  }

  // 只缓存成功的响应
  if (response.status !== 200) {
    return false;
  }

  // 检查响应头中的缓存控制
  const cacheControl = response.headers.get('Cache-Control');
  if (cacheControl && (cacheControl.includes('no-store') || cacheControl.includes('private'))) {
    return false;
  }

  // 不缓存流式响应
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') || contentType.includes('application/stream')) {
    return false;
  }

  return true;
}

/**
 * 缓存响应并设置 TTL
 * @param {Request} request - 原始请求
 * @param {Response} response - 响应对象
 */
async function cacheWithTTL(request, response) {
  try {
    const url = new URL(request.url);
    const isStatic = CONFIG.cache.staticExtensions.some(ext => url.pathname.endsWith(ext));
    const ttl = isStatic ? CONFIG.cache.staticTtl : CONFIG.cache.defaultTtl;

    // 设置缓存控制头
    response.headers.set('Cache-Control', `public, max-age=${ttl}`);

    // 添加 Vary 头支持，确保根据这些头的不同值分别缓存
    const varyHeaders = [
      'Accept-Language',
      'Accept-Encoding',
      'Authorization', // 如果有认证头，分别缓存
    ];

    // 检查原响应是否已有 Vary 头
    const existingVary = response.headers.get('Vary');
    if (existingVary) {
      // 合并已有的 Vary 头
      const combined = new Set([...existingVary.split(',').map(v => v.trim()), ...varyHeaders]);
      response.headers.set('Vary', Array.from(combined).join(', '));
    } else {
      // 只为有意义的请求添加 Vary 头
      const relevantVaryHeaders = varyHeaders.filter(header => request.headers.has(header));
      if (relevantVaryHeaders.length > 0) {
        response.headers.set('Vary', relevantVaryHeaders.join(', '));
      }
    }

    // 添加缓存时间戳
    response.headers.set('X-Cache-Date', new Date().toISOString());

    const cache = caches.default;
    await cache.put(request, response);
    log('DEBUG', `已缓存响应: ${url.pathname} (TTL: ${ttl}s)`);
  } catch (error) {
    log('ERROR', '缓存写入失败:', error.message);
  }
}

/**
 * 获取 CORS 响应头
 */
function getCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': CONFIG.allowedMethods.join(', '),
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': '*',
  };
}

/**
 * 处理 CORS 预检请求
 */
function handleCORS(request) {
  const headers = {
    ...getCORSHeaders(),
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
  };

  return new Response(null, {
    status: 204,
    headers: headers,
  });
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取 Cloudflare 数据中心位置信息
 * @param {string} colo - Cloudflare 数据中心代码（如 HKG, SIN, LAX）
 * @returns {object} 位置信息
 */
function getColoLocation(colo) {
  if (!colo || colo === 'UNKNOWN') {
    return { region: 'UNKNOWN', inChina: false };
  }

  // 中国大陆及港澳台的数据中心代码
  const chinaColo = ['HKG', 'TPE', 'SJW', 'TSN', 'SZX', 'FOC', 'CAN', 'CGO', 'CTU', 'DLC', 'HGH', 'KHN', 'NKG', 'SHA', 'TAO', 'WUH', 'XIY'];

  const coloMap = {
    // 中国大陆
    'SJW': { city: '石家庄', country: 'CN', inChina: true },
    'TSN': { city: '天津', country: 'CN', inChina: true },
    'SZX': { city: '深圳', country: 'CN', inChina: true },
    'FOC': { city: '福州', country: 'CN', inChina: true },
    'CAN': { city: '广州', country: 'CN', inChina: true },
    'CGO': { city: '郑州', country: 'CN', inChina: true },
    'CTU': { city: '成都', country: 'CN', inChina: true },
    'DLC': { city: '大连', country: 'CN', inChina: true },
    'HGH': { city: '杭州', country: 'CN', inChina: true },
    'KHN': { city: '南昌', country: 'CN', inChina: true },
    'NKG': { city: '南京', country: 'CN', inChina: true },
    'SHA': { city: '上海', country: 'CN', inChina: true },
    'TAO': { city: '青岛', country: 'CN', inChina: true },
    'WUH': { city: '武汉', country: 'CN', inChina: true },
    'XIY': { city: '西安', country: 'CN', inChina: true },

    // 港澳台
    'HKG': { city: '香港', country: 'HK', inChina: false },
    'TPE': { city: '台北', country: 'TW', inChina: false },

    // 亚太其他
    'SIN': { city: '新加坡', country: 'SG', inChina: false },
    'NRT': { city: '东京', country: 'JP', inChina: false },
    'ICN': { city: '首尔', country: 'KR', inChina: false },

    // 美洲
    'LAX': { city: '洛杉矶', country: 'US', inChina: false },
    'SJC': { city: '圣何塞', country: 'US', inChina: false },
    'SEA': { city: '西雅图', country: 'US', inChina: false },

    // 欧洲
    'LHR': { city: '伦敦', country: 'GB', inChina: false },
    'FRA': { city: '法兰克福', country: 'DE', inChina: false },
  };

  const info = coloMap[colo] || { city: colo, country: 'UNKNOWN', inChina: chinaColo.includes(colo) };

  return {
    code: colo,
    city: info.city,
    country: info.country,
    inChina: info.inChina,
    region: info.inChina ? '中国大陆' : (info.country === 'HK' ? '香港' : (info.country === 'TW' ? '台湾' : '海外')),
  };
}
