const dns = require('dns');
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.static(__dirname));

// ---------- 图片上传（存本地 uploads 目录，Railway 上挂 Volume 持久化） ----------
// 可用环境变量 UPLOAD_DIR 指定上传目录：Railway 上可设 UPLOAD_DIR=/data，再把卷挂到 /data，路径更简单
const uploadsDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 单张最大 10MB
});

app.use('/uploads', express.static(uploadsDir));

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ success: false, msg: '未收到文件' });
  res.json({ success: true, url: `/uploads/${req.file.filename}` });
});

// ---------- Database config ----------
// 连接串来自环境变量 DATABASE_URL（Railway 附加 Postgres 后自动注入；本地开发手动设置）
const databaseUrl = process.env.DATABASE_URL;

const sslConfig = { rejectUnauthorized: false };

if (!databaseUrl) {
  console.error('Missing database connection string. 请设置 DATABASE_URL 环境变量（Railway 附加 Postgres 后会自动注入）。');
  process.exit(1);
}

// ---------- 数据库配置 ----------
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: sslConfig
});


// ---------- 初始化数据库 ----------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT DEFAULT ''
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      friend_id INT NOT NULL,
      remark TEXT,
      UNIQUE(user_id, friend_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      ts BIGINT DEFAULT (EXTRACT(EPOCH FROM now())*1000)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS unread_counts (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      from_user_id INT NOT NULL,
      count INT DEFAULT 0,
      UNIQUE(user_id, from_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 消息查询索引：按 (from_user, to_user, id DESC) 加速会话历史查询
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_pair
    ON messages (from_user, to_user, id DESC);
  `);
}

// ---------- REST 接口 ----------
app.post('/register', async (req, res) => {
  const { username, password, code } = req.body;

  // 校验用户名/密码
  if (!username || !password) return res.json({ success: false, msg: '用户名/密码不能为空' });

  // 校验注册码（可用环境变量 INVITE_CODE 覆盖，默认 0123）
  const inviteCode = process.env.INVITE_CODE || '0123';
  if (code !== inviteCode) return res.json({ success: false, msg: '注册码错误' });

  try {
    await pool.query('INSERT INTO users(username, password) VALUES($1, $2)', [username, password]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, msg: err.code === '23505' ? '用户名已存在' : err.message });
  }
});


app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, msg: '用户名/密码不能为空' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE username=$1 AND password=$2', [username, password]);
    if (r.rows.length) {
      res.json({ success: true, user: r.rows[0] });
    } else {
      res.json({ success: false, msg: '用户名或密码错误' });
    }
  } catch (err) {
    res.json({ success: false, msg: err.message });
  }
});

app.get('/friends/:username', async (req, res) => {
  const username = req.params.username;
  try {
    const r = await pool.query(`
      SELECT f.friend_id, f.remark, u.username AS friend, u.avatar
      FROM friends f
      JOIN users u ON f.friend_id = u.id
      WHERE f.user_id = (SELECT id FROM users WHERE username=$1)
    `, [username]);
    res.json(r.rows.map(x => ({ friend: x.friend, avatar: x.avatar, remark: x.remark })));
  } catch (err) {
    res.json([]);
  }
});

app.post('/add-friend', async (req, res) => {
  const { user, friend, remark } = req.body;

  if (!user || !friend) return res.json({ success: false, msg: '用户名和好友不能为空' });
  if (user === friend) return res.json({ success: false, msg: '不能添加自己为好友' });

  try {
    // 获取用户 ID
    const userRes = await pool.query('SELECT id FROM users WHERE username=$1', [user]);
    const friendRes = await pool.query('SELECT id FROM users WHERE username=$1', [friend]);
    if (!userRes.rows.length || !friendRes.rows.length) return res.json({ success: false, msg: '用户不存在' });

    const userId = userRes.rows[0].id;
    const friendId = friendRes.rows[0].id;

    // 插入或更新双向好友关系
    await pool.query(`
      INSERT INTO friends(user_id, friend_id, remark)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, friend_id) DO UPDATE
      SET remark = EXCLUDED.remark
    `, [userId, friendId, remark || '']);

    await pool.query(`
      INSERT INTO friends(user_id, friend_id, remark)
      VALUES ($1, $2, '')
      ON CONFLICT (user_id, friend_id) DO NOTHING
    `, [friendId, userId]); // 对方的备注保持为空

    res.json({ success: true });

  } catch (err) {
    console.error('/add-friend ERR:', err);
    res.json({ success: false, msg: err.message });
  }
});


app.post('/set-remark', async (req, res) => {
  const { owner, friend, remark } = req.body;
  try {
    const ownerRes = await pool.query('SELECT id FROM users WHERE username=$1', [owner]);
    const friendRes = await pool.query('SELECT id FROM users WHERE username=$1', [friend]);
    if (!ownerRes.rows.length || !friendRes.rows.length) return res.json({ success: false });

    await pool.query('UPDATE friends SET remark=$1 WHERE user_id=$2 AND friend_id=$3', [
      remark,
      ownerRes.rows[0].id,
      friendRes.rows[0].id
    ]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

app.post('/profile', async (req, res) => {
  const { username, avatar } = req.body;
  try {
    await pool.query('UPDATE users SET avatar=$1 WHERE username=$2', [avatar, username]);
    res.json({ success: true });
  } catch (err) {
    console.error('/profile ERR:', err);
    res.json({ success: false });
  }
});

app.get('/messages/:user/:friend', async (req, res) => {
  const { user, friend } = req.params;
  // 分页：默认取最近 200 条；before=消息id 时取该 id 之前更早的 limit 条（聊天窗口上滑加载历史）
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const before = req.query.before ? parseInt(req.query.before) : null;
  try {
    const cond = '(from_user=$1 AND to_user=$2) OR (from_user=$2 AND to_user=$1)';
    let r;
    if (before) {
      r = await pool.query(
        `SELECT * FROM (
           SELECT * FROM messages WHERE ${cond} AND id < $3
           ORDER BY id DESC LIMIT $4
         ) sub ORDER BY id ASC`,
        [user, friend, before, limit]
      );
    } else {
      r = await pool.query(
        `SELECT * FROM (
           SELECT * FROM messages WHERE ${cond}
           ORDER BY id DESC LIMIT $3
         ) sub ORDER BY id ASC`,
        [user, friend, limit]
      );
    }
    res.json(r.rows);
  } catch (err) {
    res.json([]);
  }
});

// 一次性返回所有好友的最后一条消息（替代前端 N+1 请求）
app.get('/conversations/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const r = await pool.query(`
      SELECT DISTINCT ON (f.friend_id)
        f.friend_id, f.remark, u.username AS friend, u.avatar,
        m.id AS msg_id, m.message, m.type, m.ts, m.from_user
      FROM friends f
      JOIN users u ON u.id = f.friend_id
      LEFT JOIN messages m ON
        (m.from_user = $1 AND m.to_user = u.username)
        OR (m.to_user = $1 AND m.from_user = u.username)
      WHERE f.user_id = (SELECT id FROM users WHERE username = $1)
      ORDER BY f.friend_id, m.id DESC NULLS LAST
    `, [username]);
    res.json(r.rows);
  } catch (err) {
    console.error('/conversations ERR:', err);
    res.json([]);
  }
});

// ---------- Socket.IO ----------
const onlineUsers = {}; // username => Set<socket.id>（同一账号多设备同时在线）

function broadcastOnlineStatus() {
  const onlineList = Object.keys(onlineUsers);
  io.emit('online-status', onlineList);
}

io.on('connection', socket => {
  let currentUser = null;

  // 登录
  socket.on('login', async username => {
    currentUser = username;
    if (!onlineUsers[username]) onlineUsers[username] = new Set();
    onlineUsers[username].add(socket.id);

    // 上线时推送未读计数
    try {
      const res = await pool.query(`
        SELECT u.username AS from_user, c.count
        FROM unread_counts c
        JOIN users u ON c.from_user_id = u.id
        WHERE c.user_id = (SELECT id FROM users WHERE username=$1)
      `, [username]);
      socket.emit('unread-counts', res.rows);
    } catch (err) {
      console.error('unread-counts ERR:', err);
    }

    // 广播在线状态
    broadcastOnlineStatus();
  });

  // 发送消息
  socket.on('send-message', async data => {
    const { from, to, message, type } = data;
    if (!from || !to || !message) return;

    try {
      const ts = Date.now();
      const ins = await pool.query(
        'INSERT INTO messages(from_user,to_user,message,type,ts) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [from, to, message, type || 'text', ts]);
      const msgId = ins.rows[0].id;

      const fromRes = await pool.query('SELECT id FROM users WHERE username=$1', [from]);
      const toRes = await pool.query('SELECT id FROM users WHERE username=$1', [to]);
      if (fromRes.rows.length && toRes.rows.length) {
        const fromId = fromRes.rows[0].id;
        const toId = toRes.rows[0].id;

        await pool.query(`
          INSERT INTO unread_counts(user_id, from_user_id, count)
          VALUES($1,$2,1)
          ON CONFLICT (user_id, from_user_id) DO UPDATE
          SET count = unread_counts.count + 1
        `, [toId, fromId]);
      }

      // 推送给对方的所有在线设备，并带上服务器时间戳供前端显示
      const toSocketIds = onlineUsers[to];
      if (toSocketIds && toSocketIds.size) {
        const outData = { ...data, ts };
        toSocketIds.forEach(id => io.to(id).emit('receive-message', outData));
      }

      // 给发送方回执，前端据此清除"发送中"状态
      socket.emit('message-sent-ack', { ts, id: msgId });
    } catch (err) {
      console.error('send-message ERR:', err);
    }
  });

  // 用户打开会话，重置未读计数
  socket.on('open-conversation', async ({ user, friend }) => {
    try {
      const userRes = await pool.query('SELECT id FROM users WHERE username=$1', [user]);
      const friendRes = await pool.query('SELECT id FROM users WHERE username=$1', [friend]);
      if (userRes.rows.length && friendRes.rows.length) {
        const userId = userRes.rows[0].id;
        const friendId = friendRes.rows[0].id;
        await pool.query('UPDATE unread_counts SET count=0 WHERE user_id=$1 AND from_user_id=$2', [userId, friendId]);
      }
    } catch (err) {
      console.error('open-conversation ERR:', err);
    }
  });

  // 登出 / 断开（只移除当前连接，同一账号其他设备不受影响）
  socket.on('disconnect', () => {
    if (currentUser && onlineUsers[currentUser]) {
      onlineUsers[currentUser].delete(socket.id);
      if (onlineUsers[currentUser].size === 0) {
        delete onlineUsers[currentUser];
        broadcastOnlineStatus();
      }
    }
  });

  socket.on('logout', username => {
    if (username && onlineUsers[username]) {
      onlineUsers[username].delete(socket.id);
      if (onlineUsers[username].size === 0) {
        delete onlineUsers[username];
        broadcastOnlineStatus();
      }
    }
  }); 
});

// ---------- 启动服务器 ----------
const PORT = process.env.PORT || 3000; // 使用 Railway 分配的端口，或者本地默认 3000
async function startServer() {
  try {
    await initDB();
    console.log('DB connected');
    server.listen(PORT, () => console.log(`Server running at port ${PORT}`));
  } catch (err) {
    console.error('DB init failed:', err);
    process.exit(1);
  }
}

startServer();

