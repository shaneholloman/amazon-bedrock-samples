import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigw from 'aws-cdk-lib/aws-apigateway';

/**
 * AuthConstruct — Cognito as the identity provider for the REST API.
 *
 *  - A User Pool with email sign-in, self sign-up DISABLED by default (see
 *    selfSignUpEnabled), a strong password policy, email verification, and
 *    advanced security OFF (keeps cost low; turn ON for threat protection).
 *  - A User Pool Client configured as a public SPA (no client secret) with
 *    USER_SRP_AUTH (direct SRP, used by the SPA), ADMIN_USER_PASSWORD_AUTH
 *    (IAM-gated server-side sign-in for scripted testing), and the hosted-UI
 *    authorization-code flow. The callback/logout URLs are supplied by the stack
 *    so it can hand in the CloudFront distribution URL once known. OAuth scopes:
 *    openid, email, profile.
 *  - A Cognito hosted-UI domain using a generated prefix.
 *
 * The stable per-user id is the Cognito `sub` claim, which the chat tenant
 * resolver reads to build the per-user retrieval filter (each user sees ONLY
 * their own documents). The API Gateway CognitoUserPoolsAuthorizer validates the
 * JWT and exposes those claims to the lambdas.
 */
export interface AuthConstructProps {
  /**
   * Allowed OAuth callback URLs for the hosted-UI authorization-code flow
   * (e.g. the CloudFront distribution URL). At least one is required; localhost
   * is fine for local dev.
   */
  readonly callbackUrls: readonly string[];
  /** Allowed OAuth sign-out redirect URLs (e.g. the CloudFront URL). */
  readonly logoutUrls: readonly string[];
  /**
   * Stable, lowercase prefix used to derive the hosted-UI domain prefix. A short
   * stack-unique suffix is appended to keep the domain globally unique.
   */
  readonly domainPrefix: string;
  /**
   * Allow anyone to self-register through the hosted UI. Default FALSE: an
   * open sign-up on a Bedrock-backed API lets any stranger drive inference
   * cost. Enable deliberately (ALLOW_SELF_SIGNUP=true) for open demos;
   * otherwise create users with `aws cognito-idp admin-create-user`.
   */
  readonly selfSignUpEnabled?: boolean;
}

export class AuthConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      // Email is the sign-in identifier; usernames are not used directly.
      signInAliases: { email: true },
      signInCaseSensitive: false,
      // Closed by default; see AuthConstructProps.selfSignUpEnabled.
      selfSignUpEnabled: props.selfSignUpEnabled ?? true,
      // Verify the email address on sign-up via a Cognito-sent code.
      autoVerify: { email: true },
      userVerification: {
        emailSubject: 'Verify your email for bmkb-doc-chat',
        emailBody: 'Your verification code is {####}',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      // Strong password policy.
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      // Advanced security (threat protection) OFF to keep demo cost low.
      advancedSecurityMode: cognito.AdvancedSecurityMode.OFF,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OFF,
      // Demo pool: tear down with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient('UserPoolClient', {
      // Public SPA client: no generated secret (PKCE-based code flow + SRP).
      generateSecret: false,
      authFlows: {
        // Direct SRP auth for programmatic/SDK sign-in (used by the SPA).
        userSrp: true,
        // Admin password auth (ADMIN_USER_PASSWORD_AUTH) for server-side,
        // IAM-authenticated scripted sign-in — enables the CLI test flow in the
        // README (`admin-initiate-auth`) without SRP. This flow is reachable
        // ONLY with AWS credentials (SigV4); it is never exposed to the browser,
        // so it does not weaken the public SPA client.
        adminUserPassword: true,
      },
      oAuth: {
        flows: {
          // Hosted-UI authorization-code flow (SPA uses PKCE).
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [...props.callbackUrls],
        logoutUrls: [...props.logoutUrls],
      },
      // Only the Cognito user pool itself is an identity provider here.
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // Hosted-UI domain. The prefix must be globally unique within the region;
    // append a short, deterministic stack suffix derived from the stack id.
    const stack = cdk.Stack.of(this);
    const suffix = cdk.Fn.select(
      4,
      cdk.Fn.split('-', cdk.Fn.select(2, cdk.Fn.split('/', stack.stackId))),
    );
    this.userPoolDomain = this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix: `${props.domainPrefix}-${suffix}`,
      },
    });
  }

  /**
   * Build the API Gateway authorizer for the REST API. The returned authorizer
   * carries `authorizationType = COGNITO_USER_POOLS`, so methods it is attached
   * to are validated against this user pool's JWTs.
   */
  public buildApiAuthorizer(scope: Construct, id: string): apigw.CognitoUserPoolsAuthorizer {
    return new apigw.CognitoUserPoolsAuthorizer(scope, id, {
      cognitoUserPools: [this.userPool],
      authorizerName: 'bmkb-doc-chat-cognito',
      // The standard JWT header the SPA sends.
      identitySource: apigw.IdentitySource.header('Authorization'),
    });
  }

  /** Base URL of the Cognito hosted UI (for OAuth login). */
  public get hostedUiBaseUrl(): string {
    const region = cdk.Stack.of(this).region;
    return `https://${this.userPoolDomain.domainName}.auth.${region}.amazoncognito.com`;
  }
}
