// The workspace registry: user_id -> workspace_id -> runtime + access point + session.
//
// DynamoDB over signed HTTPS rather than @aws-sdk/client-dynamodb, for the same reason as
// sigv4.mjs: the Lambda ships as plain source with nothing to install. Two operations are
// used and both take the partition key from the caller's verified `sub`.

import { credentialsFromEnvironment, signedFetch } from './sigv4.mjs';

const DEFAULT_WORKSPACE_ID = 'default';
// Sort keys come from the query string, so they are constrained to something that cannot
// be mistaken for a key expression or grow unboundedly.
const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function normalizeWorkspaceId(value) {
  const workspaceId = String(value ?? DEFAULT_WORKSPACE_ID);
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error(`workspaceId must match ${WORKSPACE_ID_PATTERN}`);
  return workspaceId;
}

// The ONLY way a workspace record is ever read. `userId` is the verified `sub` and is the
// partition key; the client can influence the sort key and nothing else. There is no query,
// no scan and no index here on purpose — a caller cannot express "somebody else's row" in
// this API surface at all, so ownership is a property of the key shape rather than of a
// comparison someone has to remember to write.
export async function loadWorkspace({ table, region, userId, workspaceId }) {
  const item = await dynamo(region, 'GetItem', {
    TableName: table,
    Key: { user_id: { S: userId }, workspace_id: { S: normalizeWorkspaceId(workspaceId) } },
    ConsistentRead: true,
  });
  if (!item.Item) return null;
  return Object.freeze({
    userId,
    workspaceId: item.Item.workspace_id?.S,
    runtimeArn: item.Item.runtime_arn?.S ?? null,
    accessPointArn: item.Item.access_point_arn?.S ?? null,
    runtimeSessionId: item.Item.runtime_session_id?.S ?? null,
    status: item.Item.status?.S ?? 'unknown',
  });
}

// Records which session the workspace is currently living in, so the control plane can stop
// it, bill it, or notice two of them. Deliberately last-writer-wins and deliberately not on
// the authorization path: the session id is scoped to a runtime that is already the
// caller's, so it grants nothing on its own. If this write fails the mint still succeeds.
export async function recordSession({ table, region, userId, workspaceId, sessionId, seenAt = Date.now() }) {
  await dynamo(region, 'UpdateItem', {
    TableName: table,
    Key: { user_id: { S: userId }, workspace_id: { S: normalizeWorkspaceId(workspaceId) } },
    UpdateExpression: 'SET runtime_session_id = :s, session_seen_at = :t',
    ConditionExpression: 'attribute_exists(user_id)',
    ExpressionAttributeValues: { ':s': { S: sessionId }, ':t': { N: String(seenAt) } },
  });
}

async function dynamo(region, operation, body) {
  const response = await signedFetch({
    method: 'POST',
    url: `https://dynamodb.${region}.amazonaws.com/`,
    region,
    service: 'dynamodb',
    headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${operation}` },
    body: JSON.stringify(body),
    credentials: credentialsFromEnvironment(),
  });
  if (response.statusCode !== 200) {
    const detail = safeJson(response.body);
    throw new Error(`DynamoDB ${operation} failed with ${response.statusCode}: ${detail?.message ?? detail?.__type ?? response.body.slice(0, 200)}`);
  }
  return JSON.parse(response.body);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
