const {createApp,finishApp}=require('../../shared/app');
const app=createApp('reminders');app.use('/api',require('./routes'));module.exports=finishApp(app);
