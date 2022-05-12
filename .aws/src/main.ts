import { Construct } from 'constructs';
import {
  App,
  DataTerraformRemoteState,
  RemoteBackend,
  TerraformStack,
} from 'cdktf';
import { AwsProvider, datasources, kms, sns } from '@cdktf/provider-aws';
import { config } from './config';
import {
  ApplicationRDSCluster,
  PocketALBApplication,
  PocketECSCodePipeline,
  PocketPagerDuty,
  PocketVPC,
} from '@pocket-tools/terraform-modules';
import { PagerdutyProvider } from '@cdktf/provider-pagerduty';
import { NullProvider } from '@cdktf/provider-null';
import { LocalProvider } from '@cdktf/provider-local';
import { ArchiveProvider } from '@cdktf/provider-archive';

class ListAPI extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    new AwsProvider(this, 'aws', { region: 'us-east-1' });
    new PagerdutyProvider(this, 'pagerduty_provider', { token: undefined });
    new NullProvider(this, 'null-provider');
    new LocalProvider(this, 'local-provider');
    new ArchiveProvider(this, 'archive-provider');

    new RemoteBackend(this, {
      hostname: 'app.terraform.io',
      organization: 'Pocket',
      workspaces: [{ prefix: `${config.name}-` }],
    });

    const pocketVPC = new PocketVPC(this, 'pocket-vpc');
    const region = new datasources.DataAwsRegion(this, 'region');
    const caller = new datasources.DataAwsCallerIdentity(this, 'caller');

    const pocketApp = this.createPocketAlbApplication({
      pagerDuty: this.createPagerDuty(),
      secretsManagerKmsAlias: this.getSecretsManagerKmsAlias(),
      snsTopic: this.getCodeDeploySnsTopic(),
      region,
      caller,
      vpc: pocketVPC,
    });

    this.createApplicationCodePipeline(pocketApp);
  }

  /**
   * Get the sns topic for code deploy
   * @private
   */
  private getCodeDeploySnsTopic() {
    return new sns.DataAwsSnsTopic(this, 'backend_notifications', {
      name: `Backend-${config.environment}-ChatBot`,
    });
  }

  /**
   * Get secrets manager kms alias
   * @private
   */
  private getSecretsManagerKmsAlias() {
    return new kms.DataAwsKmsAlias(this, 'kms_alias', {
      name: 'alias/aws/secretsmanager',
    });
  }

  /**
   * Create CodePipeline to build and deploy terraform and ecs
   * @param app
   * @private
   */
  private createApplicationCodePipeline(app: PocketALBApplication) {
    new PocketECSCodePipeline(this, 'code-pipeline', {
      prefix: config.prefix,
      source: {
        codeStarConnectionArn: config.codePipeline.githubConnectionArn,
        repository: config.codePipeline.repository,
        branchName: config.codePipeline.branch,
      },
    });
  }

  /**
   * Create PagerDuty service for alerts
   * @private
   */
  private createPagerDuty() {
    const incidentManagement = new DataTerraformRemoteState(
      this,
      'incident_management',
      {
        organization: 'Pocket',
        workspaces: {
          name: 'incident-management',
        },
      }
    );

    return new PocketPagerDuty(this, 'pagerduty', {
      prefix: config.prefix,
      service: {
        criticalEscalationPolicyId: incidentManagement
          .get('policy_backend_critical_id')
          .toString(),
        nonCriticalEscalationPolicyId: incidentManagement
          .get('policy_backend_non_critical_id')
          .toString(),
      },
    });
  }

  /**
   * Creates a serverless aurora RDS.
   * This function should only be used when the environment is Dev
   * @private
   */
  private createRds(vpc: PocketVPC) {
    return new ApplicationRDSCluster(this, 'dev-aurora', {
      prefix: `${config.prefix}`,
      vpcId: vpc.vpc.id,
      subnetIds: vpc.privateSubnetIds,
      rdsConfig: {
        databaseName: config.rds.databaseName,
        masterUsername: config.rds.masterUsername,
        skipFinalSnapshot: true,
        engine: 'aurora-mysql',
        engineMode: 'serverless',
        scalingConfiguration: {
          minCapacity: config.rds.minCapacity,
          maxCapacity: config.rds.maxCapacity,
          autoPause: false,
        },
        deletionProtection: false,
      },
      tags: config.tags,
    });
  }

  private createPocketAlbApplication(dependencies: {
    pagerDuty: PocketPagerDuty;
    region: datasources.DataAwsRegion;
    caller: datasources.DataAwsCallerIdentity;
    secretsManagerKmsAlias: kms.DataAwsKmsAlias;
    snsTopic: sns.DataAwsSnsTopic;
    vpc: PocketVPC;
  }): PocketALBApplication {
    const { pagerDuty, region, caller, secretsManagerKmsAlias, snsTopic, vpc } =
      dependencies;

    const databaseSecretsArn = `arn:aws:secretsmanager:${region.name}:${caller.accountId}:secret:${config.name}/${config.environment}/READITLA_DB`;

    /**
     * Create an RDS instance if we are working in the Dev account.
     * This is only to facilitate testing
     */
    let rdsCluster: ApplicationRDSCluster;

    const secretResources = [
      `arn:aws:secretsmanager:${region.name}:${caller.accountId}:secret:Shared`,
      `arn:aws:secretsmanager:${region.name}:${caller.accountId}:secret:Shared/*`,
      secretsManagerKmsAlias.targetKeyArn,
      `arn:aws:secretsmanager:${region.name}:${caller.accountId}:secret:${config.name}/${config.environment}`,
      `arn:aws:secretsmanager:${region.name}:${caller.accountId}:secret:${config.name}/${config.environment}/*`,
      `arn:aws:secretsmanager:${region.name}:${caller.accountId}:secret:${config.prefix}`,
      `arn:aws:secretsmanager:${region.name}:${caller.accountId}:secret:${config.prefix}/*`,
    ];

    // Set out the DB connection details for the production (legacy) database.
    let databaseSecretEnvVars = {
      readHost: `${databaseSecretsArn}:read_host::`,
      readUser: `${databaseSecretsArn}:read_username::`,
      readPassword: `${databaseSecretsArn}:read_password::`,
      writeHost: `${databaseSecretsArn}:write_host::`,
      writeUser: `${databaseSecretsArn}:write_username::`,
      writePassword: `${databaseSecretsArn}:write_password::`,
    };

    if (config.isDev) {
      rdsCluster = this.createRds(vpc);
      // Add Dev RDS-specific secrets if in Dev environment
      secretResources.push(rdsCluster.secretARN);

      // Specify DB connection details for the RDS cluster on Dev
      databaseSecretEnvVars = {
        readHost: rdsCluster.secretARN + ':host::',
        readUser: rdsCluster.secretARN + ':username::',
        readPassword: rdsCluster.secretARN + ':password::',
        writeHost: rdsCluster.secretARN + ':host::',
        writeUser: rdsCluster.secretARN + ':username::',
        writePassword: rdsCluster.secretARN + ':password::',
      };
    }

    return new PocketALBApplication(this, 'application', {
      internal: true,
      prefix: config.prefix,
      alb6CharacterPrefix: config.shortName,
      tags: config.tags,
      cdn: false,
      domain: config.domain,
      containerConfigs: [
        {
          name: 'app',
          portMappings: [
            {
              hostPort: 4005,
              containerPort: 4005,
            },
          ],
          healthCheck: {
            command: [
              'CMD-SHELL',
              'curl -f http://localhost:4005/.well-known/apollo/server-health || exit 1',
            ],
            interval: 15,
            retries: 3,
            timeout: 5,
            startPeriod: 0,
          },
          envVars: [
            {
              name: 'NODE_ENV',
              value: process.env.NODE_ENV,
            },
            {
              name: 'DATABASE_READ_PORT',
              value: config.envVars.databasePort,
            },
            {
              name: 'DATABASE_WRITE_PORT',
              value: config.envVars.databasePort,
            },
            {
              name: 'SQS_PUBLISHER_DATA_QUEUE_URL',
              value: `https://sqs.${region.name}.amazonaws.com/${caller.accountId}/${config.envVars.sqsPublisherDataQueueName}`,
            },
            {
              name: 'KINESIS_UNIFIED_EVENT_STREAM',
              value: config.envVars.unifiedEventStreamName,
            },
            {
              name: 'DATABASE_TZ',
              value: config.envVars.databaseTz,
            },
          ],
          secretEnvVars: [
            {
              name: 'PARSER_DOMAIN',
              valueFrom: `arn:aws:ssm:${region.name}:${caller.accountId}:parameter/${config.name}/${config.environment}/PARSER_DOMAIN`,
            },
            {
              name: 'SNOWPLOW_ENDPOINT',
              valueFrom: `arn:aws:ssm:${region.name}:${caller.accountId}:parameter/${config.name}/${config.environment}/SNOWPLOW_ENDPOINT`,
            },
            {
              name: 'SENTRY_DSN',
              valueFrom: `arn:aws:ssm:${region.name}:${caller.accountId}:parameter/${config.name}/${config.environment}/SENTRY_DSN`,
            },
            {
              name: 'DATABASE_READ_HOST',
              valueFrom: databaseSecretEnvVars.readHost,
            },
            {
              name: 'DATABASE_READ_USER',
              valueFrom: databaseSecretEnvVars.readUser,
            },
            {
              name: 'DATABASE_READ_PASSWORD',
              valueFrom: databaseSecretEnvVars.readPassword,
            },
            {
              name: 'DATABASE_WRITE_HOST',
              valueFrom: databaseSecretEnvVars.writeHost,
            },
            {
              name: 'DATABASE_WRITE_USER',
              valueFrom: databaseSecretEnvVars.writeUser,
            },
            {
              name: 'DATABASE_WRITE_PASSWORD',
              valueFrom: databaseSecretEnvVars.writePassword,
            },
          ],
        },
        {
          name: 'xray-daemon',
          containerImage: 'amazon/aws-xray-daemon',
          repositoryCredentialsParam: `arn:aws:secretsmanager:${region.name}:${caller.accountId}:secret:Shared/DockerHub`,
          portMappings: [
            {
              hostPort: 2000,
              containerPort: 2000,
              protocol: 'udp',
            },
          ],
          command: ['--region', 'us-east-1', '--local-mode'],
        },
      ],
      codeDeploy: {
        useCodeDeploy: true,
        useCodePipeline: true,
        snsNotificationTopicArn: snsTopic.arn,
      },
      exposedContainer: {
        name: 'app',
        port: 4005,
        healthCheckPath: '/.well-known/apollo/server-health',
      },
      ecsIamConfig: {
        prefix: config.prefix,
        taskExecutionRolePolicyStatements: [
          //This policy could probably go in the shared module in the future.
          {
            actions: ['secretsmanager:GetSecretValue', 'kms:Decrypt'],
            resources: secretResources,
            effect: 'Allow',
          },
          //This policy could probably go in the shared module in the future.
          {
            actions: ['ssm:GetParameter*'],
            resources: [
              `arn:aws:ssm:${region.name}:${caller.accountId}:parameter/${config.name}/${config.environment}`,
              `arn:aws:ssm:${region.name}:${caller.accountId}:parameter/${config.name}/${config.environment}/*`,
            ],
            effect: 'Allow',
          },
        ],
        taskRolePolicyStatements: [
          {
            actions: [
              'xray:PutTraceSegments',
              'xray:PutTelemetryRecords',
              'xray:GetSamplingRules',
              'xray:GetSamplingTargets',
              'xray:GetSamplingStatisticSummaries',
            ],
            resources: ['*'],
            effect: 'Allow',
          },
          {
            actions: ['sqs:SendMessage', 'sqs:SendMessageBatch'],
            resources: [
              `arn:aws:sqs:${region.name}:${caller.accountId}:${config.envVars.sqsPublisherDataQueueName}`,
            ],
            effect: 'Allow',
          },
          {
            actions: ['kinesis:PutRecord', 'kinesis:PutRecords'],
            resources: [
              `arn:aws:kinesis:${region.name}:${caller.accountId}:stream/${config.envVars.unifiedEventStreamName}`,
            ],
            effect: 'Allow',
          },
        ],
        taskExecutionDefaultAttachmentArn:
          'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
      },
      autoscalingConfig: {
        targetMinCapacity: 2,
        targetMaxCapacity: 10,
      },
      alarms: {
        //TODO: When we start using this more we will change from non-critical to critical
        http5xxErrorPercentage: {
          threshold: 25,
          evaluationPeriods: 4,
          period: 300,
          actions: [pagerDuty.snsNonCriticalAlarmTopic.arn],
        },
      },
    });
  }
}

const app = new App();
new ListAPI(app, 'list-api');
app.synth();
