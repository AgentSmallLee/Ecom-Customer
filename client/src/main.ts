// client/src/main.ts —— 前端应用入口，只做一件事：创建并启动 Vue 应用
import { createApp } from 'vue';
import App    from './App.vue';
import router from './router/index.ts';

// ── 应用启动三步（链式调用，等价于分三行）───────────────────────────
// createApp(App)        : ① 以 App.vue 为根组件创建「应用实例」
// .use(router)          : ② 注册 Vue Router 插件，把路由装进应用
// .mount('#app')        : ③ 把应用挂载到 index.html 里的 <div id="app">
//
// ① createApp(App)
//    - App.vue 是根组件，整个页面（全局导航栏 <router-view />）都从它渲染出去
//    - 与 Vue2 的 new Vue() 全局单例不同：Vue3 用工厂函数，可创建多个独立应用，
//      互不污染全局状态（如微前端、同页多应用场景）
//    - 返回的 app 实例拥有 use / mount / component / directive 等方法
//
// ② .use(router)
//    - Vue3 的「插件」机制：app.use(插件) 会调用插件的 install(app) 方法
//    - 此处装入 router（见 router/index.ts），安装后整个应用可用：
//        · <router-link> / <router-view />  声明式组件（App.vue 导航栏在用）
//        · useRouter() / useRoute()         组合式 API
//        · 路由守卫、history 状态管理
//    - 挂载顺序很重要：必须先 use(router) 再 mount，否则路由组件注册不进去
//
// ③ .mount('#app')
//    - 参数 '#app' 是 CSS 选择器，指向 index.html 里 <div id="app"></div>
//    - 把应用实例渲染进该节点并替换其内容，mount 之后页面才真正显示
//    - 返回的是「根组件实例」（此处未接收），后续可调用 app 生命周期相关方法
//
// 三步合起来 = 创建 → 装路由 → 上屏，是全项目唯一入口，
// 页面渲染链路：main.ts 挂载 App.vue → App.vue 渲染导航栏 + <router-view /> →
// <router-view /> 根据当前 URL 渲染对应视图（ChatView / AgentView / RagView / GraphView）
createApp(App).use(router).mount('#app');
