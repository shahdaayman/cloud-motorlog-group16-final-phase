class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function bad(message='Invalid request') { return new HttpError(400, 'VALIDATION_ERROR', message); }
function unauthorized(message='Authentication required') { return new HttpError(401, 'UNAUTHENTICATED', message); }
function forbidden(message='Access denied') { return new HttpError(403, 'FORBIDDEN', message); }
function missing(message='Resource not found') { return new HttpError(404, 'NOT_FOUND', message); }
function conflict(message='Conflicting resource') { return new HttpError(409, 'CONFLICT', message); }
function asyncRoute(fn) { return (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next); }
function sendError(err, req, res, next) {
  if (res.headersSent) return next(err);
  const cognitoStatus={NotAuthorizedException:401,CodeMismatchException:401,ExpiredCodeException:401,UserNotConfirmedException:403,UsernameExistsException:409,InvalidPasswordException:400,InvalidParameterException:400,TooManyRequestsException:429,LimitExceededException:429,UserNotFoundException:401};
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : (cognitoStatus[err.name]||500);
  if(status===400||status===401||status===403)console.warn(JSON.stringify({type:'security_event',event:status===400?'invalid_input':'authorization_failed',method:req.method,path:req.path,statusCode:status,code:err.code||err.name||'REQUEST_ERROR'}));
  if (status >= 500) console.error(JSON.stringify({at: new Date().toISOString(), level:'error',method:req.method,path:req.path,code:err.code||'INTERNAL',message:String(err.message).slice(0,160)}));
  const safeCognitoMessage={NotAuthorizedException:'Invalid credentials or authentication session.',CodeMismatchException:'The verification code is incorrect.',ExpiredCodeException:'The verification code has expired. Request a new code.',TooManyRequestsException:'Too many attempts. Please wait and try again.',LimitExceededException:'The request limit was reached. Please wait before trying again.',UserNotFoundException:'Invalid credentials',UsernameExistsException:'Unable to create this registration.'};
  res.status(status).json({error:{code:status===500?'INTERNAL_ERROR':(err.code||err.name||'REQUEST_ERROR'),message:status===500?'Internal server error':(safeCognitoMessage[err.name]||err.message)}});
}
module.exports = {HttpError,bad,unauthorized,forbidden,missing,conflict,asyncRoute,sendError};
