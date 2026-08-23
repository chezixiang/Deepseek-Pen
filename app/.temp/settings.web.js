import Vue from 'D:\\codes\\youdao\\Deepseek\\app\\node_modules\\aiot-vue-cli\\cli-libs\\vue\\dist\\vue.runtime.common.js';
import weex from 'D:\\codes\\youdao\\Deepseek\\app\\node_modules\\aiot-vue-cli\\web-libs\\falcon-vue-render\\packages\\falcon-vue-render\\dist\\index.common.js';

weex.init(Vue);

const App = require('..\\src\\pages\\settings\\settings.vue');
if(!window.$falcon){
  console.error('boot fail! please open _preview.app.html to preview app!');
} else {
  $falcon._web_boot_page(App, Vue, window);
}