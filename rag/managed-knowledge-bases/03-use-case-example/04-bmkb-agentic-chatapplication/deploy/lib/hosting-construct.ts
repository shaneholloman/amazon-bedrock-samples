import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve `<repo>/frontend/dist`. This file runs either from source
 * (`infra/lib`) or compiled (`infra/dist/lib`); walk up from here until the
 * directory holding `frontend` is found so the path is correct in both cases.
 * Returns `undefined` when `frontend/dist` is absent so synth stays robust.
 */
function resolveFrontendDist(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'frontend', 'dist');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * HostingConstruct — CloudFront + private S3 static hosting for the frontend.
 *
 *  - Private S3 bucket: block ALL public access, SSE (S3-managed), versioned,
 *    TLS-only bucket policy, ownership enforced. NOT public-read; the only
 *    reader is CloudFront via an Origin Access Control (OAC) grant scoped to
 *    this distribution.
 *  - CloudFront distribution fronting the bucket with OAC (the modern
 *    replacement for the legacy origin access identity), via
 *    `S3BucketOrigin.withOriginAccessControl`.
 *      - Default root object `index.html`.
 *      - SPA routing: 403/404 from S3 are rewritten to `/index.html` with a
 *        200 so client-side routes resolve.
 *      - Viewer protocol policy redirect-to-https; TLSv1.2_2021 minimum.
 *      - A managed cache policy plus a response-headers policy that sets the
 *        baseline security headers (HSTS, X-Content-Type-Options nosniff,
 *        X-Frame-Options DENY, Referrer-Policy).
 *
 *  Asset deployment: this construct does NOT require a built frontend at synth
 *  time. When `frontend/dist` exists it provisions a `BucketDeployment` that
 *  uploads the build and invalidates the CloudFront cache; when it is absent
 *  (the common synth-only / CI case) deployment is skipped and the documented
 *  manual `aws s3 sync` step in README handles it. Either way `cdk synth`
 *  succeeds.
 */
export interface HostingConstructProps {
  /** Base name used to tag the distribution comment. */
  readonly baseName?: string;
}

/**
 * Runtime configuration written to `config.json` in the frontend bucket. These
 * are the values the SPA fetches at startup (see frontend runtime-config.ts) —
 * all PUBLIC (no secrets): the API base, and the Cognito SPA client coordinates.
 * They are sourced from live stack constructs, so config.json cannot drift from
 * the resources it describes.
 */
export interface FrontendRuntimeConfig {
  readonly apiBase: string;
  readonly cognito: {
    readonly authority: string;
    readonly clientId: string;
    readonly domain: string;
  };
}

export class HostingConstruct extends Construct {
  /** Private origin bucket holding the built SPA. */
  public readonly bucket: s3.Bucket;
  /** CloudFront distribution fronting the bucket. */
  public readonly distribution: cloudfront.Distribution;
  /** Fully-qualified `https://` URL of the distribution (use as a CORS origin). */
  public readonly url: string;
  /** Bare CloudFront domain name (no scheme). */
  public readonly domainName: string;
  /** CloudFront distribution id (for `aws cloudfront create-invalidation`). */
  public readonly distributionId: string;

  constructor(scope: Construct, id: string, props: HostingConstructProps = {}) {
    super(scope, id);

    const baseName = props.baseName ?? 'bmkb';

    // Private origin bucket: no public access whatsoever. CloudFront reads it
    // through an OAC grant (added automatically by S3BucketOrigin below). SSE,
    // versioning, ownership-enforced, and a TLS-only bucket policy match the
    // hardening on the documents bucket.
    this.bucket = new s3.Bucket(this, 'FrontendBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      publicReadAccess: false,
      // Sample stack: clean teardown. autoDeleteObjects also clears versions
      // (delete markers) on a versioned bucket so `cdk destroy` empties it.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'abort-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    // Baseline security headers on every viewer response. HSTS (2 years +
    // includeSubDomains + preload), nosniff, DENY framing, and a tight
    // referrer policy. Applied via a managed-style response-headers policy.
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: `${baseName} frontend security headers`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${baseName} frontend`,
      // SPA entrypoint served at the apex path.
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // S3BucketOrigin.withOriginAccessControl provisions an OAC and wires a
        // bucket-policy grant scoped to this distribution. The legacy OAI is
        // intentionally avoided. Cast to IBucket: under exactOptionalPropertyTypes
        // the concrete Bucket's optional `isWebsite` is not directly assignable.
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket as s3.IBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: securityHeaders,
      },
      // SPA routing: S3 returns 403 (object missing, OAC) or 404 for deep
      // links; rewrite both to the SPA shell with a 200 so the client router
      // takes over.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: false,
    });

    this.domainName = this.distribution.distributionDomainName;
    this.url = `https://${this.domainName}`;
    this.distributionId = this.distribution.distributionId;
  }

  /**
   * Deploy the built SPA AND its runtime `config.json` in ONE atomic
   * BucketDeployment, then invalidate CloudFront. Called at the END of stack
   * construction (after Cognito + API exist) so config.json is written from the
   * live stack outputs — the bundle and the config it needs land together and
   * cannot drift.
   *
   * Synth-robust: when `frontend/dist` is absent (CI / synth-only), this no-ops
   * with a clear annotation instead of failing. `cdk deploy` builds the SPA
   * first (see the deploy npm script), so a real deploy always has the assets.
   *
   * Cache strategy: fingerprinted `assets/*` are immutable and long-cached;
   * `config.json` and `index.html` are marked no-cache so a redeploy takes
   * effect immediately without requiring the caller to bust caches by hand.
   */
  public deployFrontend(config: FrontendRuntimeConfig): void {
    const distDir = resolveFrontendDist();
    if (distDir === undefined) {
      cdk.Annotations.of(this).addWarning(
        'frontend/dist not found at synth time — skipping asset deployment. ' +
          'Build the frontend (npm run build --workspace frontend) before cdk deploy.',
      );
      return;
    }

    // Two deployments to ONE bucket, each pruning ONLY its own key namespace so
    // they never delete each other's objects:
    //
    //  1) Fingerprinted assets under `assets/` — content-hashed, so safe to
    //     cache immutably for a year. destinationKeyPrefix:'assets' scopes
    //     prune:true to that prefix only (a root-level prune would race-delete
    //     the shell files below).
    //  2) The SPA shell (index.html, favicon) + runtime config.json at the root
    //     — no-cache, so a redeploy (new asset hash in index.html, new
    //     coordinates in config.json) is picked up on the very next load with
    //     no manual invalidation. This is the pair that kills stale-bundle and
    //     stale-config failures. prune:false so it leaves `assets/` untouched.
    const assetsDir = path.join(distDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      new s3deploy.BucketDeployment(this, 'DeployFrontendAssets', {
        sources: [s3deploy.Source.asset(assetsDir)],
        destinationBucket: this.bucket as s3.IBucket,
        destinationKeyPrefix: 'assets',
        distribution: this.distribution,
        distributionPaths: ['/assets/*'],
        prune: true,
        cacheControl: [
          s3deploy.CacheControl.setPublic(),
          s3deploy.CacheControl.maxAge(cdk.Duration.days(365)),
          s3deploy.CacheControl.immutable(),
        ],
      });
    }

    new s3deploy.BucketDeployment(this, 'DeployFrontendShell', {
      sources: [
        s3deploy.Source.asset(distDir, { exclude: ['assets/**'] }),
        s3deploy.Source.jsonData('config.json', {
          apiBase: config.apiBase,
          cognito: {
            authority: config.cognito.authority,
            clientId: config.cognito.clientId,
            domain: config.cognito.domain,
          },
        }),
      ],
      destinationBucket: this.bucket as s3.IBucket,
      distribution: this.distribution,
      distributionPaths: ['/index.html', '/config.json', '/favicon.svg'],
      prune: false,
      cacheControl: [s3deploy.CacheControl.noCache(), s3deploy.CacheControl.mustRevalidate()],
    });
  }
}
