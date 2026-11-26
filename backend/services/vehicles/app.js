const {createApp,finishApp}=require('../../shared/app');
const app=createApp('vehicles');app.use('/api',require('./routes'));module.exports=finishApp(app);
