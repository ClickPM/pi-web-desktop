"use strict";

/**
 * Hot-updates the locally installed Pi Desktop application.
 * Packs the updated Electron shell into D:/Program Files/Pi/resources/app.asar.
 */

const asar = require("@electron/asar");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGET_DIR = "D:/Program Files/Pi";
const RESOURCES_DIR = path.join(TARGET_DIR, "resources");
const ASAR_PATH = path.join(RESOURCES_DIR, "app.asar");
const BACKUP_PATH = path.join(RESOURCES_DIR, "app.asar.bak");
const STAGING_DIR = path.join(ROOT, ".hot_update_staging");

async function main() {
  console.log("=== Pi Desktop 本地安装版热更程序 ===");

  if (!fs.existsSync(ASAR_PATH)) {
    throw new Error(`未找到安装目录中的 app.asar: ${ASAR_PATH}`);
  }

  // 1. 备份原 app.asar（如果还没有备份的话）
  if (!fs.existsSync(BACKUP_PATH)) {
    console.log(`[1/5] 备份原 app.asar -> ${BACKUP_PATH}`);
    fs.copyFileSync(ASAR_PATH, BACKUP_PATH);
  } else {
    console.log(`[1/5] 发现已有备份 app.asar.bak，跳过覆盖以保留初始版本`);
  }

  // 2. 准备暂存文件目录
  console.log(`[2/5] 准备暂存文件...`);
  if (fs.existsSync(STAGING_DIR)) fs.rmSync(STAGING_DIR, { recursive: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  // 复制 electron 目录
  fs.cpSync(path.join(ROOT, "electron"), path.join(STAGING_DIR, "electron"), { recursive: true });
  // 复制 package.json
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(STAGING_DIR, "package.json"));
  // 复制 build 图标
  fs.mkdirSync(path.join(STAGING_DIR, "build"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "build", "icon.png"), path.join(STAGING_DIR, "build", "icon.png"));
  fs.copyFileSync(path.join(ROOT, "build", "icon-pi.png"), path.join(STAGING_DIR, "build", "icon-pi.png"));

  // 3. 打包为临时 asar
  const tempAsar = path.join(RESOURCES_DIR, "app.asar.new");
  console.log(`[3/5] 打包新 app.asar...`);
  await asar.createPackage(STAGING_DIR, tempAsar);

  // 4. 原子替换
  console.log(`[4/5] 写入安装目录 ${ASAR_PATH}...`);
  if (fs.existsSync(ASAR_PATH)) {
    fs.unlinkSync(ASAR_PATH);
  }
  fs.renameSync(tempAsar, ASAR_PATH);

  // 清理暂存
  fs.rmSync(STAGING_DIR, { recursive: true });

  // 5. 验证安装产物
  const list = asar.listPackage(ASAR_PATH);
  console.log(`[5/5] 验证更新结果: 共 ${list.length} 个文件`);

  const requiredFiles = [
    "\\electron\\main.js",
    "\\electron\\host-bridge.js",
    "\\electron\\host-process.js",
    "\\electron\\host-protocol.js",
    "\\electron\\http-response-parser.js",
  ];

  for (const f of requiredFiles) {
    if (!list.includes(f)) {
      throw new Error(`热更产物校验缺失关键文件: ${f}`);
    }
  }

  // 清理 bridge 磁盘缓存以便重新释放
  const bridgeCache = path.join(process.env.APPDATA, "pi-web-desktop", "bridge");
  if (fs.existsSync(bridgeCache)) {
    fs.rmSync(bridgeCache, { recursive: true });
    console.log(`已重置旧桥接脚本缓存: ${bridgeCache}`);
  }

  console.log("\n>>> 本地安装版热更成功完成！<<<");
  console.log(`安装路径: ${TARGET_DIR}`);
  console.log(`更新时间: ${new Date().toLocaleString()}`);
}

main().catch((err) => {
  console.error("热更失败:", err);
  process.exit(1);
});
