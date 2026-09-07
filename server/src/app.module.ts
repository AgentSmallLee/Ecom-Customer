// server/src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController }      from './app.controller.ts';
import { ChatModule }         from './chat/chat.module.ts';
import { AgentModule }        from './agent/agent.module.ts';
import { RagModule }          from './rag/rag.module.ts';
import { GraphModule }        from './graph/graph.module.ts';

/**
 * 应用根模块（Root Module）
 *
 * NestJS 采用模块化架构，AppModule 是整个应用的入口模块，
 * NestFactory.create(AppModule) 会从这里开始构建整个依赖注入容器。
 *
 * @Module 装饰器的作用：
 *   - imports：    导入其他功能模块，把它们的 providers 和 controllers 整合进来
 *   - controllers：当前模块自身的控制器（处理 HTTP 请求）
 *   - providers：  当前模块的服务（可被注入的类）
 *   - exports：    当前模块对外暴露的 providers，供其他模块导入后使用
 *
 * 本项目模块划分：
 *   - ChatModule   对话相关接口（聊天消息、会话管理）
 *   - AgentModule  Agent 编排（多工具调用、工作流）
 *   - RagModule    RAG 检索增强（知识库、向量化、相似度检索）
 *   - GraphModule  知识图谱接口
 *   - AppController 根路径服务信息接口（/）
 */
@Module({
  imports: [ChatModule, AgentModule, RagModule, GraphModule],
  controllers: [AppController],
})
export class AppModule {}
