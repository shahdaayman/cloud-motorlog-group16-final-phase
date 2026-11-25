const {AdminDeleteUserCommand}=require('@aws-sdk/client-cognito-identity-provider');
const db=require('../../shared/db');
const {bad,conflict,missing}=require('../../shared/errors');
const {resolveRoles,resolveUsername}=require('./admin-roles');

const RELATED_TABLES=['Maintenance','Fuel','Expenses','Reminders','Vehicles'];
function requireDeleteConfirmation(body){if(body?.confirmation!=='DELETE')throw bad('Type DELETE to confirm permanent account deletion');}
async function assertAdminSafety({idp,userPoolId,targetId,actorId,allowSelf=false}){
  if(!allowSelf&&targetId===actorId)throw bad('Cannot delete your own account from the Admin Dashboard');
  const profiles=await db.scanAll('Users');
  const existing=profiles.find(user=>user.id===targetId);
  if(existing?.status==='Deleting')return {...existing,role:existing.deletionRole||'User'};
  const roles=await resolveRoles(idp,userPoolId,profiles);
  if(roles.some(user=>user.role==='Unavailable')){const error=new Error('Administrator membership could not be verified safely');error.status=503;error.code='ROLE_LOOKUP_UNAVAILABLE';throw error;}
  const target=roles.find(user=>user.id===targetId);
  if(!target)throw missing('User not found');
  const activeAdmins=roles.filter(user=>user.role==='Admin'&&user.status==='Active');
  if(target.role==='Admin'&&target.status==='Active'&&activeAdmins.length<=1)throw conflict('Cannot delete the last active administrator');
  return target;
}
async function permanentlyDelete({idp,userPoolId,targetId,deletionRole='User'}){
  const profile=await db.get('Users',targetId);
  if(!profile)throw missing('User not found');
  const username=profile.cognitoUsername||await resolveUsername(idp,userPoolId,targetId);
  await db.patch('Users',targetId,{status:'Deleting',deletionRole,cognitoUsername:username,deletionStartedAt:profile.deletionStartedAt||new Date().toISOString()});
  const deleted={};
  for(const table of RELATED_TABLES)deleted[table]=await db.deleteByOwner(table,targetId);
  try{await idp.send(new AdminDeleteUserCommand({UserPoolId:userPoolId,Username:username}));}catch(error){if(error.name!=='UserNotFoundException')throw error;}
  await db.del('Users',targetId);
  return deleted;
}
module.exports={RELATED_TABLES,requireDeleteConfirmation,assertAdminSafety,permanentlyDelete};
