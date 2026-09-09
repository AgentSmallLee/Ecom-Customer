// server/src/tools/order-tools.ts
// 订单相关工具集合
// 所有查询工具都绑定 userId，确保只能查询当前用户的数据（防越权）
import { tool } from '@langchain/core/tools';
import { z }    from 'zod';
import { orders, logistics } from '../data/mock.ts';

/**
 * 工厂函数：根据 userId 创建订单详情查询工具
 * 内部做权限校验，确保只能查当前用户的订单
 */
export const createGetOrderInfoTool = (userId: string) =>
  tool(
    async ({ orderId }) => {
      const order = orders[orderId];
      if (!order) return JSON.stringify({ error: `订单 ${orderId} 不存在` });
      // 权限校验：订单必须属于当前用户
      if (order.userId !== userId) {
        return JSON.stringify({ error: `订单 ${orderId} 不存在` });
      }
      return JSON.stringify(order);
    },
    {
      name: 'getOrderInfo',
      description:
        '根据订单号查询订单详情，包括订单状态、商品列表、金额、快递信息。当用户询问订单状态、订单内容时调用。',
      schema: z.object({
        orderId: z.string().describe('订单号，格式为 ORD-xxx，例如 ORD-001'),
      }),
    }
  );

/**
 * 工厂函数：根据 userId 创建物流查询工具
 * 内部做权限校验：通过订单反向确认该快递单号属于当前用户
 */
export const createGetLogisticsTool = (userId: string) =>
  tool(
    async ({ trackingNo }) => {
      // 权限校验：先确认这个快递单号属于当前用户的某个订单
      const orderWithTracking = Object.values(orders).find(
        (o) => o.trackingNo === trackingNo && o.userId === userId
      );
      if (!orderWithTracking) {
        return JSON.stringify({ error: `快递单号 ${trackingNo} 暂无物流信息` });
      }
      const records = logistics[trackingNo];
      if (!records)
        return JSON.stringify({ error: `快递单号 ${trackingNo} 暂无物流信息` });
      return JSON.stringify({ trackingNo, records });
    },
    {
      name: 'getLogisticsInfo',
      description:
        '根据快递单号查询物流轨迹，包括各节点时间、地点、状态。当用户询问快递到哪了、物流状态时调用。',
      schema: z.object({
        trackingNo: z.string().describe('快递单号，例如 SF1234567890'),
      }),
    }
  );

/**
 * 工厂函数：创建"查询当前用户订单列表"的工具
 * userId 由外部注入（来自 config.configurable.user_id），LLM 调用时不需要传 userId 参数
 */
export const createGetUserOrdersTool = (userId: string) =>
  tool(
    async () => {
      const userOrders = Object.values(orders).filter((o) => o.userId === userId);
      if (userOrders.length === 0)
        return JSON.stringify({ error: `暂无订单记录` });
      const summary = userOrders.map((o) => ({
        orderId:    o.orderId,
        status:     o.status,
        amount:     o.amount,
        createTime: o.createTime,
      }));
      return JSON.stringify(summary);
    },
    {
      name: 'getUserOrders',
      description:
        '查询当前用户的所有订单列表摘要。当用户询问"我有哪些订单"、"我的订单"、"最近的订单"时调用。',
      schema: z.object({}),
    }
  );

/**
 * 工厂函数：根据 userId 创建一整套订单工具（全部带权限校验）
 * - 订单详情查询
 * - 物流轨迹查询
 * - 用户订单列表
 */
export const createOrderTools = (userId: string) => [
  createGetOrderInfoTool(userId),
  createGetLogisticsTool(userId),
  createGetUserOrdersTool(userId),
];
