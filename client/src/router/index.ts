// client/src/router/index.ts
import { createRouter, createWebHistory } from 'vue-router';
import ChatView  from '../views/ChatView.vue';
import AgentView from '../views/AgentView.vue';
import RagView   from '../views/RagView.vue';
import GraphView from '../views/GraphView.vue';
import 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    title: string;
  }
}

const routes = [
  { path: '/',       component: ChatView,  meta: { title: '基础对话' } },
  { path: '/agent',  component: AgentView, meta: { title: 'Agent 订单查询' } },
  { path: '/rag',    component: RagView,   meta: { title: '商品咨询' } },
  { path: '/graph',  component: GraphView, meta: { title: '智能客服' } },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});
