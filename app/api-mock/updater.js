/**
 * updater 模块浏览器 mock：恒返回"已是最新版本"。
 * 机制见 api-mock/langningchen.js 头注释。
 */

export default {
  // 检查状态
  ST_UP_TO_DATE: 0, ST_CHECK_PENDING: 1, ST_HAS_NEW_VERSION: 2,
  ST_DOWNLOADING: 3, ST_DOWNLOAD_DONE: 4, ST_INSTALLING: 5, ST_DOWNLOAD_PAUSED: 6,
  // 下载结果
  DL_ERROR: -1, DL_ABORTED: -2, DL_SUCCESS: 0, DL_ERROR_ON_GOING: -3, DL_PAUSED: -4,
  // 下载原因
  DL_REASON_ABORT_INIT_ERROR: 1, DL_REASON_ABORT_URL_INACCESSIBLE: 2,
  DL_REASON_ABORT_MD5_MISMATCH: 3, DL_REASON_ABORT_UNKNOWN: 4,
  DL_REASON_PAUSE_NETWORK_BROKEN: 5, DL_REASON_PAUSE_INSUFFICIENT_SPACE: 6,
  DL_REASON_PAUSE_IO_EXCEPTION: 7, DL_REASON_PAUSE_UNKNOWN: 8,
  // 安装结果
  INS_ERROR_INSTALLATION: -1, INS_ERROR_NO_INSTALL_PACKAGE: -2,
  INS_ERROR_INSTALL_ALREADY_ON_GOING: -3, INS_ERROR_NO_UPDATE_INFO: -4, INS_SUCCESS: 0,
  // 全局事件
  EVT_UPDATE_CHECK_PENDING: 1, EVT_UPDATE_CHECK_ERROR: 2, EVT_GOT_ALREADY_UP_TO_DATE: 3,
  EVT_GOT_NEW_VERSION: 4, EVT_DOWNLOAD_PENDING: 5, EVT_DOWNLOAD_PERCENT_CHANGE: 6,
  EVT_DOWNLOAD_ERROR: 7, EVT_DOWNLOAD_DONE: 8, EVT_INSTALLING: 9,
  EVT_INSTALL_SUCCESS: 10, EVT_INSTALL_ERROR: 11, EVT_DOWNLOAD_PAUSED: 12,

  getUpdateInfo(appid, callback) {
    console.log(`[mock] updater.getUpdateInfo(${appid})`)
    if (callback) {
      setTimeout(() => callback({ status: this.ST_UP_TO_DATE }), 200)
    }
  },
  startDownload(appid, callback) {
    console.log(`[mock] updater.startDownload(${appid})`)
    if (callback) callback({ result: this.DL_ERROR, reason: this.DL_REASON_ABORT_URL_INACCESSIBLE })
  },
  installUpdate(appid, callback) {
    console.log(`[mock] updater.installUpdate(${appid})`)
    if (callback) callback({ result: this.INS_ERROR_NO_INSTALL_PACKAGE })
  },
  on(event, callback) {
    console.log(`[mock] updater.on(${event}) 已注册`)
    if (event === 'ready' && callback) setTimeout(callback, 0)
  },
  isReady() { return true }
}
