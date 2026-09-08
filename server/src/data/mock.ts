// server/src/data/mock.ts

export interface OrderItem {
  name: string;
  qty: number;
  price: number;
}

export interface Order {
  orderId:    string;
  userId:     string;
  status:     string;
  createTime: string;
  amount:     number;
  items:      OrderItem[];
  carrier:    string | null;
  trackingNo: string | null;
}

export interface LogisticsRecord {
  time:     string;
  location: string;
  desc:     string;
}

export const orders: Record<string, Order> = {
  'ORD-001': {
    orderId:    'ORD-001',
    userId:     'U-100',
    status:     '已发货',
    createTime: '2025-03-20 10:30:00',
    amount:     299.00,
    items: [
      { name: 'iPhone 手机壳', qty: 2, price: 49.5 },
      { name: '钢化膜',        qty: 1, price: 200  },
    ],
    carrier:    '顺丰速运',
    trackingNo: 'SF1234567890',
  },
  'ORD-002': {
    orderId:    'ORD-002',
    userId:     'U-100',
    status:     '待付款',
    createTime: '2025-03-22 15:00:00',
    amount:     899.00,
    items: [{ name: '蓝牙耳机', qty: 1, price: 899 }],
    carrier:    null,
    trackingNo: null,
  },
  'ORD-003': {
    orderId:    'ORD-003',
    userId:     'U-101',
    status:     '已完成',
    createTime: '2025-03-18 09:00:00',
    amount:     1299.00,
    items: [{ name: '机械键盘', qty: 1, price: 1299 }],
    carrier:    '京东物流',
    trackingNo: 'JD9876543210',
  },

  // 演示用：UUID 格式的测试用户订单（与客户端 ecom_user_id 格式一致）
  // 本地调试时，在浏览器控制台执行：
  //   localStorage.setItem('ecom_user_id', 'U-demo0001')
  // 刷新页面后，"查我的订单"就能查到以下订单
  'ORD-101': {
    orderId:    'ORD-101',
    userId:     'U-demo0001',
    status:     '已发货',
    createTime: '2025-09-01 14:20:00',
    amount:     599.00,
    items: [
      { name: '红松心选 坚果礼盒', qty: 2, price: 159 },
      { name: '红松心选 蜂蜜礼盒', qty: 1, price: 281 },
    ],
    carrier:    '顺丰速运',
    trackingNo: 'SF20250901001',
  },
  'ORD-102': {
    orderId:    'ORD-102',
    userId:     'U-demo0001',
    status:     '待发货',
    createTime: '2025-09-05 09:10:00',
    amount:     368.00,
    items: [{ name: '红松心选 茶叶礼盒', qty: 1, price: 368 }],
    carrier:    null,
    trackingNo: null,
  },
  'ORD-103': {
    orderId:    'ORD-103',
    userId:     'U-demo0001',
    status:     '已完成',
    createTime: '2025-08-15 16:45:00',
    amount:     128.00,
    items: [{ name: '红松心选 红枣枸杞茶', qty: 4, price: 32 }],
    carrier:    '中通快递',
    trackingNo: 'ZT20250815008',
  },
};

export const logistics: Record<string, LogisticsRecord[]> = {
  'SF1234567890': [
    { time: '2025-03-21 08:00', location: '上海转运中心', desc: '快件已发出'           },
    { time: '2025-03-21 18:30', location: '杭州分拨中心', desc: '快件到达'             },
    { time: '2025-03-22 09:00', location: '杭州西湖营业点', desc: '派件中，预计今日送达' },
  ],
  'JD9876543210': [
    { time: '2025-03-18 14:00', location: '北京仓库',     desc: '已揽收' },
    { time: '2025-03-19 10:00', location: '北京转运中心', desc: '运输中' },
    { time: '2025-03-20 08:00', location: '用户门口',     desc: '已签收' },
  ],

  // 演示用户订单的物流
  'SF20250901001': [
    { time: '2025-09-02 08:00', location: '长春仓库',       desc: '已揽收'           },
    { time: '2025-09-02 20:00', location: '沈阳转运中心',   desc: '快件已发出'       },
    { time: '2025-09-03 10:00', location: '北京顺义分拨中心', desc: '快件到达'       },
    { time: '2025-09-03 16:00', location: '北京朝阳营业点', desc: '派件中，预计今日送达' },
  ],
  'ZT20250815008': [
    { time: '2025-08-16 10:00', location: '金华仓库',       desc: '已揽收'     },
    { time: '2025-08-17 08:00', location: '杭州转运中心',   desc: '运输中'     },
    { time: '2025-08-18 14:00', location: '北京转运中心',   desc: '到达目的城市' },
    { time: '2025-08-19 11:00', location: '客户签收',       desc: '已签收'     },
  ],
};
