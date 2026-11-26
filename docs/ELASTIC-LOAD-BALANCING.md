# Motorlog Elastic Load Balancing on Floci

## Validated topology

This is an additional application-serving path, not a replacement for or component of the existing CloudFront → S3 and API Gateway → Lambda paths.

```text
Browser/test client
  → 127.0.0.1:4510 loopback-only TCP exposure
  → Floci ALB HTTP listener :80
  → motorlog-http-targets (HTTP, target type IP)
      → 192.168.65.254:3101 → motorlog-a → existing Express/Motorlog services
      → 192.168.65.254:3102 → motorlog-b → existing Express/Motorlog services
```

The two independent Node processes run `backend/dev-server.js`, including the existing frontend, Cognito login/MFA flow, JWT verification, Admin checks, ownership checks, DynamoDB access and real `/api/health` endpoint. The ALB has no response cache. `X-Motorlog-Instance` contains only `motorlog-a` or `motorlog-b` and is used as sanitized distribution evidence.

The ALB-served `js/config.js` explicitly points browser API calls to the existing API Gateway invoke URL. The exact ALB browser origin is allow-listed on all three Lambda services. Thus the ALB serves the UI and health demonstration while authenticated application calls retain the established API Gateway → Lambda → Cognito/JWT path.

## Frontend HTTP compatibility fix

The first ALB frontend rendered without styling even though every referenced asset returned HTTP 200 with the correct MIME type. Helmet's default CSP included `upgrade-insecure-requests`; browsers therefore changed relative HTTP CSS and JavaScript requests on port 4510 to HTTPS. The local Floci listener is HTTP-only, so those upgraded requests failed before Express could serve them. The local Express CSP now omits only that directive while retaining the remaining Helmet policy. No production CloudFront/S3 security header was relaxed.

The verification enumerates every CSS and JavaScript reference for the user and Admin entry points, checks status and MIME type through the ALB, compares the response bodies from ports 3101 and 3102, rejects HTML fallback content, checks that the CSP cannot upgrade local assets, validates the API Gateway base configuration and tests exact-origin preflight responses.

## Deployed resources

- ALB: `motorlog-alb`
- ARN: `arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/motorlog-alb/c8fed1e2ad83459b`
- Floci DNS metadata: `motorlog-alb-c8fed1e2ad83459b.elb.floci`
- Working loopback URL: `http://motorlog-alb-c8fed1e2ad83459b.elb.localhost.floci.io:4510`
- Listener: HTTP port 80, ARN `arn:aws:elasticloadbalancing:us-east-1:000000000000:listener/app/motorlog-alb/c8fed1e2ad83459b/285efea5e17a4ac1`
- Target group: `motorlog-http-targets`
- Target group ARN: `arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/motorlog-http-targets/7367fbfa832d4aae`
- Health check: HTTP `GET /api/health`, traffic port, matcher `200`, interval 5 seconds, timeout 2 seconds, healthy/unhealthy thresholds 2
- Dedicated VPC: `10.60.0.0/16`, with subnets in `us-east-1a` and `us-east-1b`
- Loopback proxy container: `motorlog-alb-loopback-proxy`, published only as `127.0.0.1:4510`

The Docker-reachable host address is resolved dynamically with `getent hosts host.docker.internal`; it was `192.168.65.254` for this deployment. It is not hardcoded in source and can be overridden with `MOTORLOG_ALB_TARGET_IP`.

## Verification evidence

Both targets reached `healthy`. Twenty sequential requests were distributed exactly 10/10 between `motorlog-a` and `motorlog-b`. The verification then stopped only the recorded `motorlog-b` process, waited until Floci reported port 3102 as `unhealthy`, and sent eight requests. All eight were served by `motorlog-a`. The script restarted `motorlog-b` and waited for it to return to `healthy`.

Anonymous `GET /api/vehicles` through the ALB returned HTTP 401, demonstrating that the alternate ingress does not bypass Cognito/JWT middleware. Authentication and Admin authorization code was not changed. The ALB root and `/api/health` returned HTTP 200. Existing API Gateway health and CloudFront frontend requests also returned HTTP 200 after the failover test.

## Commands from the repository root

```cmd
npm run alb:deploy
npm run alb:status
npm run alb:verify
npm run check
```

Deployment is repeatable: it reuses the named VPC, ALB, target group, listener, target processes and proxy when present. Ports 3000 and 4566 remain unchanged. Target processes use 3101/3102; the loopback listener uses 4510.

## Safe rollback

Rollback is explicit and scoped:

```cmd
npm run alb:rollback
```

It deletes only the Motorlog listener, ALB and target group, removes the disposable loopback proxy, and stops the two recorded target PIDs after verifying they are Node processes. It retains the small dedicated VPC/subnets/security group so redeployment remains recoverable. It does not touch Floci volumes, CloudFront, S3, API Gateway, Lambda, Cognito, DynamoDB, SQS, SES, IAM or EventBridge.

## Floci limitations and scaling statement

Floci binds ALB HTTP listeners inside its container rather than assigning real AWS network interfaces. The loopback TCP sidecar makes that listener reachable from Windows without recreating Floci or exposing it beyond the local host. Floci stores subnet and security-group declarations but does not enforce their packet filtering; host/Docker exposure is the effective local boundary. The target ports must listen on the Windows host gateway so Floci can reach them.

This proves control-plane resources, health monitoring, real HTTP forwarding, round-robin distribution and local failover. It does not prove AWS multi-AZ availability, production security-group enforcement, autoscaling, global distribution, or capacity for one million users. Production scaling remains an architectural property of stateless services, AWS-managed load balancing and independently scaled targets, not a claim derived from this single-host test.
