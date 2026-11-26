/**
 * Motorlog / Group 16: one-time LOCAL Floci SQS -> Lambda worker -> SES integration test.
 * Save this file in the project root next to package.json and run:
 *   node motorlog-process-one-notification.js
 * This is not the production scheduler or SQS event-source mapping.
 */
require('dotenv').config();
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { awsOptions } = require('./backend/shared/config');
const { handleQueue } = require('./backend/services/reminders/worker');
const db = require('./backend/shared/db');

async function main() {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const queueUrl = process.env.NOTIFICATION_QUEUE_URL;
  if (endpoint !== 'http://localhost:4566' || !queueUrl?.startsWith('http://localhost:4566/')) {
    throw new Error('This helper is limited to local Floci. Check AWS_ENDPOINT_URL and NOTIFICATION_QUEUE_URL in .env.');
  }
  if (!process.env.SES_FROM_EMAIL) throw new Error('SES_FROM_EMAIL is missing from .env.');

  const sqs = new SQSClient(awsOptions);
  const received = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 0, VisibilityTimeout: 60
  }));
  const message = received.Messages?.[0];
  if (!message) {
    console.log('No visible SQS messages. Wait about 60 seconds if one was received previously.');
    return;
  }
  console.log('Received one SQS message:', message.MessageId);
  const result = await handleQueue({
    Records: [{ eventSource: 'aws:sqs', messageId: message.MessageId, body: message.Body }]
  });
  if (result.batchItemFailures?.length) {
    console.error('Email worker reported a failure. Message NOT deleted; it can be retried after visibility timeout.');
    process.exitCode = 1;
    return;
  }
  // Confirm whether the reminder record was marked as emailed before printing success.
  const job = JSON.parse(message.Body);
  const reminder = job.reminderId ? await db.get('Reminders', job.reminderId) : null;
  const wasSent = Boolean(reminder && reminder.lastEmailSentOn === job.today);
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  if (wasSent) {
    console.log('SUCCESS: SES accepted the reminder email; DynamoDB marked it sent; SQS message deleted.');
    console.log('Check the local Floci SES mailbox: http://localhost:4566/_aws/ses');
  } else {
    console.log('Worker skipped this message (e.g. reminder completed, inactive user, or no matching record).');
    console.log('SQS message deleted after successful no-op handling.');
  }
}
main().catch(err => {
  console.error('Integration test failed:', err.name, err.message);
  process.exitCode = 1;
});
