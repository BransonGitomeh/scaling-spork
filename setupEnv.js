const { Compute } = require('@google-cloud/compute');
const { Client } = require('ssh2');

// Replace with your Google Cloud project ID and zone
const projectId = 'your-project-id';
const zone = 'asia-southeast1-b'; // Example: Asia region
const instanceName = 'test-instance';

// Path to your service account key file
const keyFilename = 'path/to/your-service-account-key.json';

// Initialize the Compute client
const compute = new Compute({ projectId, keyFilename });

// SSH credentials (replace with your SSH key details)
const sshUsername = '_bran'; // Replace with the output of `whoami`
const sshPrivateKey = require('fs').readFileSync('/home/_bran/.ssh/id_rsa'); // Replace with the path to your private key

// VM configuration
const config = {
  http: true,
  https: true,
  machineType: `zones/${zone}/machineTypes/e2-medium`,
  disks: [
    {
      boot: true,
      autoDelete: true,
      initializeParams: {
        sourceImage: 'projects/debian-cloud/global/images/family/debian-11',
      },
    },
  ],
  networkInterfaces: [
    {
      network: 'global/networks/default',
      accessConfigs: [
        {
          name: 'External NAT',
          type: 'ONE_TO_ONE_NAT',
        },
      ],
    },
  ],
  metadata: {
    items: [
      {
        key: 'ssh-keys',
        value: `${sshUsername}:${sshPrivateKey.toString()}`,
      },
    ],
  },
};

async function createVM() {
  try {
    console.log('Creating VM instance...');
    const [vm, operation] = await compute.zone(zone).createVM(instanceName, config);
    console.log(`VM instance created: ${vm.name}`);
    await operation.promise();
    console.log('VM is now running.');

    // Get the external IP of the VM
    const [metadata] = await vm.getMetadata();
    const externalIp = metadata.networkInterfaces[0].accessConfigs[0].natIP;
    console.log(`VM external IP: ${externalIp}`);

    // SSH into the VM and run commands
    await sshIntoVM(externalIp);
  } catch (error) {
    console.error('Error creating VM:', error);
  }
}

async function sshIntoVM(ip) {
  const conn = new Client();
  conn
    .on('ready', () => {
      console.log('SSH connection established.');
      // Run commands on the VM
      conn.exec('echo "Hello, World!"', (err, stream) => {
        if (err) throw err;
        stream
          .on('close', (code, signal) => {
            console.log('Command execution completed.');
            conn.end();
          })
          .on('data', (data) => {
            console.log(`STDOUT: ${data}`);
          })
          .stderr.on('data', (data) => {
            console.log(`STDERR: ${data}`);
          });
      });
    })
    .connect({
      host: ip,
      port: 22,
      username: sshUsername,
      privateKey: sshPrivateKey,
    });
}

// Run the script
createVM();