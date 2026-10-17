import path from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * 计算运行时数据存储目录
 *
 * @param {string} projectRoot - 项目根目录路径
 * @param {Record<string, string | undefined>} [env=process.env] - 环境变量对象
 * @returns {string} 数据目录绝对路径
 */
export function getRuntimeDataDir(projectRoot, env = process.env) {
  if (!projectRoot || typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error('projectRoot 必须是非空字符串');
  }

  const configured = env ? env.TYPORA_DATA_DIR : undefined;
  if (configured !== undefined && configured !== null) {
    if (typeof configured !== 'string' || configured.trim() === '') {
      throw new Error('TYPORA_DATA_DIR 不能为空');
    }
    return path.resolve(projectRoot, configured.trim());
  }

  return path.join(path.resolve(projectRoot), 'work');
}

/**
 * 确保运行时数据存储目录存在并返回绝对路径
 *
 * @param {string} projectRoot - 项目根目录路径
 * @param {Record<string, string | undefined>} [env=process.env] - 环境变量对象
 * @returns {Promise<string>} 数据目录绝对路径
 */
export async function ensureRuntimeDataDir(projectRoot, env = process.env) {
  const dir = getRuntimeDataDir(projectRoot, env);
  await mkdir(dir, { recursive: true });
  return dir;
}
