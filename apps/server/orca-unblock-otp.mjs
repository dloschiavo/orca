import pg from 'pg';
const c = new pg.Client({ host: 'localhost', port: 5464, user: 'orca', password: 'orca', database: 'orca' });
await c.connect();
const id = '4f012c3a-399f-430a-a9f1-e18298403fd4';
const before = await c.query('SELECT id, status, claude_session_id, dispatch_fail_count, blocked_reason FROM stories WHERE id = $1', [id]);
console.log('BEFORE:', JSON.stringify(before.rows[0], null, 2));
const r = await c.query(
  `UPDATE stories
     SET claude_session_id = NULL,
         claude_session_system_prompt_hash = NULL,
         dispatch_fail_count = 0,
         status = 'backlog',
         blocked_reason = NULL,
         dispatch_pid = NULL,
         dispatch_state = NULL,
         updated_at = NOW()
   WHERE id = $1
   RETURNING id, status, claude_session_id, dispatch_fail_count, blocked_reason`,
  [id],
);
console.log('AFTER:', JSON.stringify(r.rows[0], null, 2));
await c.query(
  `INSERT INTO activity_events (story_id, kind, actor, payload)
   VALUES ($1, 'state_transition', 'system',
           '{"status":"backlog","reason":"manual_unblock_session_cleared"}'::jsonb)`,
  [id],
);
await c.end();
