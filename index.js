import { REST, Routes, Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } from 'discord.js';
import mysql from 'mysql2/promise';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const Config = {
    Token: process.env.TOKEN,
    ClientID: process.env.CLIENT_ID,
    BackupChannel: process.env.BACKUP_CHANNEL,
    PermissionRoles: process.env.PERMISSION_ROLES.split(',').map(role => role.trim()),
    NoPermsError: process.env.NO_PERMISSION_MESSAGE || "You do not have permission to execute this command",
    Command: {
        Name: process.env.COMMAND_NAME || "backup",
        Description: process.env.COMMAND_DESCRIPTION || "Create a new database backup",
        Option: {
            Name: process.env.COMMAND_OPTION_NAME || "database",
            Description: process.env.COMMAND_OPTION_DESCRIPTION || "Name of the database",
        },
    },
    Database: {
        Host: process.env.DB_HOST,
        User: process.env.DB_USER,
        Password: process.env.DB_PASSWORD,
    },
    Backup: {
        AutoTime: process.env.AUTO_BACKUP_TIME || "00:00",
        Databases: process.env.AUTO_BACKUP_DATABASES.split(',').map(db => db.trim()),
    },
    Embed: {
        Title: process.env.EMBED_TITLE || "Backup Bot",
        Description: process.env.EMBED_DESCRIPTION || "Backup for database `${databaseName}` created",
        Fields: {
            FileSize: process.env.EMBED_FIELDS_FILESIZE || "File Size",
            CreationDate: process.env.EMBED_FIELDS_CREATIONDATE || "Creation Date",
            Duration: process.env.EMBED_FIELDS_DURATION || "Duration",
        },
        Footer: process.env.EMBED_FOOTER || "Backup completed",
    },
};

async function sendEmbedMessage(channel, buffer, databaseName, duration) {
    const timestamp = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
    const attachment = new AttachmentBuilder(buffer, { name: `${databaseName}-${timestamp}.sql` });

    const embed = new EmbedBuilder()
        .setTitle(Config.Embed.Title)
        .setURL('https://github.com/e1nbyte')
        .setDescription(Config.Embed.Description.replace('${databaseName}', databaseName))
        .addFields(
            { name: Config.Embed.Fields.FileSize, value: `${(Buffer.byteLength(buffer) / (1024 * 1024)).toFixed(2)} MB`, inline: false },
            { name: Config.Embed.Fields.CreationDate, value: new Date().toLocaleString(), inline: false },
            { name: Config.Embed.Fields.Duration, value: `${duration} seconds`, inline: false },
        )
        .setColor(0xed4245)
        .setTimestamp()
        .setFooter({ text: Config.Embed.Footer });

    await channel.send({ embeds: [embed], files: [attachment] });
}

async function createBackup(databaseName) {
    let connection

    try {
        connection = await mysql.createConnection({
            host: Config.Database.Host,
            user: Config.Database.User,
            password: Config.Database.Password,
            database: databaseName,
        });

        const duration = Date.now();
        const [tables] = await connection.query('SHOW TABLES');

        let content = `-- MySQL dump for database: ${databaseName}\n`;

        for (const row of tables) {
            const table = Object.values(row)[0];
            content += await generateBackupTable(connection, table);
        }

        return {
            buffer: Buffer.from(content, 'utf-8'),
            duration: ((Date.now() - duration) / 1000).toFixed(2)
        };

    } catch (e) {
        console.error(`Error creating backup for database \`${databaseName}\`:`, e);
        throw e;
    } finally {
        await connection.end();
    }
}

async function generateBackupTable(connection, table) {
    const [TableQuery] = await connection.query(`SHOW CREATE TABLE \`${table}\``);
    const [rows] = await connection.query(`SELECT * FROM \`${table}\``);

    let content = `\n\n-- Structure for table \`${table}\`\n${TableQuery[0]['Create Table']};\n`;

    if (rows.length > 0) {

        content += `\n-- Data for table \`${table}\`\n`;

        rows.forEach(row => {
            const values = Object.values(row).map(val => typeof val === 'string' ? `'${val.replace(/'/g, "\\'")}'` : val).join(', ');
            content += `INSERT INTO \`${table}\` VALUES (${values});\n`;
        });
    }

    return content;
}

async function handleScheduledBackups(client) {
    const channel = await client.channels.fetch(Config.BackupChannel);

    for (const databaseName of Config.Backup.Databases) {
        const { buffer, duration } = await createBackup(databaseName);
        await sendEmbedMessage(channel, buffer, databaseName, duration);
    }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
    console.log(`Bot started as ${client.user.username}`);

    const [hour, minute] = Config.Backup.AutoTime.split(':');
    cron.schedule(`0 ${minute} ${hour} * * *`, async () => {
        await handleScheduledBackups(client);
    });
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const roleCache = interaction.member.roles.cache;
    const hasPerms = Config.PermissionRoles.some(roleIds => roleCache.has(roleIds));

    if (interaction.commandName === Config.Command.Name) {

        if (!hasPerms) {
            await interaction.reply({ content: Config.NoPermsError, ephemeral: true });
            return;
        }

        const databaseName = interaction.options.getString(Config.Command.Option.Name);
        const channel = await client.channels.fetch(Config.BackupChannel);

        const { buffer, duration } = await createBackup(databaseName);

        await sendEmbedMessage(channel, buffer, databaseName, duration);
        await interaction.reply({ content: `Backup for ${databaseName} created`, ephemeral: true });
    }
});

const commands = [
    {
        name: Config.Command.Name,
        description: Config.Command.Description,
        options: [
            {
                name: Config.Command.Option.Name,
                description: Config.Command.Option.Description,
                type: 3,
                required: true,
            },
        ],
    },
];

client.login(Config.Token);

const rest = new REST({ version: 10 }).setToken(Config.Token);

(async () => {
    try {
        await rest.put(Routes.applicationCommands(Config.ClientID), { body: commands });
    } catch (error) {
        console.error(error);
    }
})();
