/** Pure observation assertions shared by the image driver and its negative controls.
 * No client, filesystem access, agent state synthesis or process launch.
 */
import { strict as assert } from 'node:assert'

export function assertPermissionPosts(rows: any[], trail: any[], tokens: string[], instance: string, channel: string) {
  // Count all destinations and failed calls too; no HTTP post may hide below
  // the production trail emitter or outside the configured channel.
  const posts = rows.filter(row => row.event === 'api' && row.method === 'chat.postMessage')
  const events = trail.filter(event => event.event === 'cscb.chat_post.attempted')
  assert.equal(posts.length, tokens.length, 'HTTP post count differs from expected requests')
  assert.deepEqual(events.map(event => event.request_token), tokens, 'unexpected post tokens/order')
  assert.equal(new Set(tokens).size, tokens.length, 'duplicate expected token')
  const joined = events.map(event => {
    assert.equal(event.ok, true, 'unsuccessful production post')
    assert.equal(event.instance_id, instance)
    assert.equal(event.channel, channel)
    assert.equal(typeof event.slack_ts, 'string')
    assert(event.slack_ts.length > 0)
    const matches = posts.filter(row => row.response_ts === event.slack_ts)
    assert.equal(matches.length, 1, 'production post lacks one actual Slack response')
    const post = matches[0]
    assert.equal(post.channel, channel)
    assert.equal(post.answer, 'ok')
    assert.equal(post.args_token_like, false, 'Slack arguments leaked or lack leak metadata')
    assert.equal(post.text, event.text)
    assert.deepEqual(post.blocks, event.blocks)
    return { request_token: event.request_token, slack_ts: post.response_ts, channel: post.channel }
  })
  for (const post of posts) {
    assert.equal(events.filter(event => event.slack_ts === post.response_ts).length, 1,
      'actual Slack response lacks one production post')
  }
  return { post_count: posts.length, posts: joined }
}

export function assertListStates(rows: any[], expected: { state: string; displayed_state?: string } | null) {
  assert.equal(rows.length, expected === null ? 0 : 1, 'unexpected list membership/count')
  if (expected !== null) {
    assert.equal(rows[0].state, expected.state, 'wrong returned list state')
    if (expected.displayed_state !== undefined) {
      assert.equal(rows[0].displayed_state, expected.displayed_state, 'wrong returned list displayed_state')
    }
  }
}
