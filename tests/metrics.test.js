const test=require('node:test');
const assert=require('node:assert/strict');
const {namespace,allowed,buildMetric}=require('../backend/shared/metrics');

test('metrics use the approved namespace and bounded dimensions',()=>{
  assert.equal(namespace,'Motorlog/Application');
  assert.deepEqual([...allowed],['API5xxErrors','ReminderChecks','ReminderCheckFailures','RemindersQueued','NotificationsProcessed','NotificationFailures']);
  const metric=buildMetric('NotificationsProcessed',1,{service:'reminders',operation:'notification'});
  assert.equal(metric.MetricName,'NotificationsProcessed');
  assert.deepEqual(metric.Dimensions.map(x=>x.Name),['Environment','Service','Operation']);
  assert.equal(JSON.stringify(metric).includes('email'),false);
});

test('API error metric is aggregateable and rejects unknown names',()=>{
  assert.deepEqual(buildMetric('API5xxErrors').Dimensions.map(x=>x.Name),['Environment']);
  assert.throws(()=>buildMetric('UserEmail',1),/Unsupported/);
  assert.throws(()=>buildMetric('ReminderChecks',Number.NaN),/finite/);
});
