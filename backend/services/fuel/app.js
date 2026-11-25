const {createApp,finishApp}=require('../../shared/app');
const app=createApp('fuel');app.use('/api',require('./routes'));module.exports=finishApp(app);
