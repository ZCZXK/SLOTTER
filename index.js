const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  ChannelType, 
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const Database = require('better-sqlite3');
const express = require('express');
require('dotenv').config();

// Web Server to Keep Hosting Online
const app = express();
app.get('/', (req, res) => res.status(200).send({ status: 'Online', timestamp: new Date() }));
app.listen(process.env.PORT || 3000, () => console.log('Web server heartbeat initialized.'));

// Database Initialization
const db = new Database('bot_data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS slot_codes (
    code TEXT PRIMARY KEY,
    durationMs INTEGER,
    used INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ping_codes (
    code TEXT PRIMARY KEY,
    type TEXT,
    amount INTEGER,
    used INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS active_slots (
    user_id TEXT PRIMARY KEY,
    channel_id TEXT,
    expires_at INTEGER,
    here_pings INTEGER DEFAULT 0,
    everyone_pings INTEGER DEFAULT 0,
    title TEXT DEFAULT 'Authorized Merchant Channel',
    description TEXT DEFAULT 'Welcome to my official slot channel!'
  );
  CREATE TABLE IF NOT EXISTS vouches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT,
    author_id TEXT,
    comment TEXT,
    timestamp INTEGER
  );
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    vouch_channel_id TEXT,
    vouch_emoji TEXT DEFAULT '⭐'
  );
`);

const PREFIX = '$';
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function parseDuration(durationStr) {
  switch (durationStr.toLowerCase()) {
    case '1w': return 7 * 24 * 60 * 60 * 1000;
    case '1m': return 30 * 24 * 60 * 60 * 1000;
    case '3m': return 90 * 24 * 60 * 60 * 1000;
    case 'lifetime': return Infinity;
    default: return null;
  }
}

function generateCode(prefix) {
  return `${prefix}-` + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function errorEmbed(title, description) {
  return new EmbedBuilder().setTitle(`❌ ${title}`).setDescription(description).setColor(0xED4245);
}

// Slash Command Register Definitions
const slashCommands = [
  new SlashCommandBuilder().setName('setup').setDescription('Deploy VIP Slot & Ping redemption panels (Admin Only)'),
  new SlashCommandBuilder().setName('gslot').setDescription('Generate a slot activation token (Admin Only)')
    .addStringOption(opt => opt.setName('duration').setDescription('1w, 1m, 3m, or lifetime').setRequired(true)),
  new SlashCommandBuilder().setName('gping').setDescription('Generate a ping credit token (Admin Only)')
    .addStringOption(opt => opt.setName('type').setDescription('Ping type').setRequired(true).addChoices({ name: 'here', value: 'here' }, { name: 'everyone', value: 'everyone' }))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Number of pings').setRequired(true)),
  new SlashCommandBuilder().setName('setvouchchannel').setDescription('Set dedicated vouch channel (Admin Only)')
    .addChannelOption(opt => opt.setName('channel').setDescription('Vouch channel').setRequired(true)),
  new SlashCommandBuilder().setName('setvouchreaction').setDescription('Set vouch reaction emoji (Admin Only)')
    .addStringOption(opt => opt.setName('emoji').setDescription('Reaction emoji').setRequired(true)),
  new SlashCommandBuilder().setName('title').setDescription('Set custom title for your slot')
    .addStringOption(opt => opt.setName('text').setDescription('New channel title').setRequired(true)),
  new SlashCommandBuilder().setName('desc').setDescription('Set store description for your slot')
    .addStringOption(opt => opt.setName('text').setDescription('New store description').setRequired(true)),
  new SlashCommandBuilder().setName('renameslot').setDescription('Rename your slot channel')
    .addStringOption(opt => opt.setName('name').setDescription('New channel name suffix').setRequired(true)),
  new SlashCommandBuilder().setName('stats').setDescription('View your slot details and remaining ping credits'),
  new SlashCommandBuilder().setName('nuke').setDescription('Clear all messages in your slot channel'),
  new SlashCommandBuilder().setName('here').setDescription('Send an @here ping in your slot channel')
    .addStringOption(opt => opt.setName('message').setDescription('Message payload').setRequired(true)),
  new SlashCommandBuilder().setName('everyone').setDescription('Send an @everyone ping in your slot channel')
    .addStringOption(opt => opt.setName('message').setDescription('Message payload').setRequired(true)),
  new SlashCommandBuilder().setName('vouch').setDescription('Vouch for a merchant')
    .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
    .addStringOption(opt => opt.setName('comment').setDescription('Feedback comment').setRequired(true)),
  new SlashCommandBuilder().setName('vouches').setDescription('View vouches for a user')
    .addUserOption(opt => opt.setName('user').setDescription('Target user (optional)').setRequired(false))
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
  console.log(`[SYSTEM] Logged in as ${client.user.tag}`);
  client.user.setActivity('Slot Management | /setup', { type: 3 });

  // Auto-Register Slash Commands globally
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('[SYSTEM] Successfully registered all Slash Commands globally.');
  } catch (err) {
    console.error('[SYSTEM] Failed to register slash commands:', err);
  }

  // Cron Check for Expired Slots (Every 60 Seconds)
  setInterval(async () => {
    const now = Date.now();
    const expiredSlots = db.prepare('SELECT * FROM active_slots WHERE expires_at != -1 AND expires_at <= ?').all(now);

    for (const slot of expiredSlots) {
      try {
        const guild = client.guilds.cache.first();
        if (guild) {
          const channel = guild.channels.cache.get(slot.channel_id);
          if (channel) await channel.delete('Slot duration expired.');
        }
      } catch (err) {
        console.error(`Failed to delete expired channel ${slot.channel_id}:`, err);
      } finally {
        db.prepare('DELETE FROM active_slots WHERE user_id = ?').run(slot.user_id);
      }
    }
  }, 60000);
});

// SLASH COMMAND HANDLER
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName, member, guild, channel, user } = interaction;

    // Helper to send command responses
    const reply = async (payload) => {
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    };

    // Admin Commands
    if (commandName === 'setup') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        return reply({ embeds: [errorEmbed('Access Denied', 'Requires `Administrator` privileges.')], ephemeral: true });
      }
      const slotPanel = new EmbedBuilder()
        .setTitle('⚡ VIP Slot Management')
        .setDescription('Claim your dedicated text channel by activating a valid slot token below.\n\n**Features Included:**\n• Custom branding (`〢⤷slot-username`)\n• Isolated messaging rights\n• Granular ping allocations')
        .setColor(0x2B2D31);
      const slotRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_claim_slot').setLabel('Activate Slot Token').setStyle(ButtonStyle.Success).setEmoji('🔑'));

      const pingPanel = new EmbedBuilder()
        .setTitle('🔔 Audience Reach Credits')
        .setDescription('Redeem additional announcement pings (`@here` / `@everyone`) for your active slot channel.')
        .setColor(0x2B2D31);
      const pingRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_claim_ping').setLabel('Redeem Ping Token').setStyle(ButtonStyle.Primary).setEmoji('🎟️'));

      await channel.send({ embeds: [slotPanel], components: [slotRow] });
      await channel.send({ embeds: [pingPanel], components: [pingRow] });
      return reply({ content: '✅ Panels deployed.', ephemeral: true });
    }

    if (commandName === 'gslot') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) return reply({ embeds: [errorEmbed('Access Denied', 'Requires `Administrator` privileges.')], ephemeral: true });
      const durationStr = interaction.options.getString('duration');
      const durationMs = parseDuration(durationStr);
      if (!durationMs) return reply({ embeds: [errorEmbed('Invalid Parameters', 'Valid durations: `1w`, `1m`, `3m`, `lifetime`')], ephemeral: true });

      const code = generateCode('SLOT');
      db.prepare('INSERT INTO slot_codes (code, durationMs) VALUES (?, ?)').run(code, durationMs === Infinity ? -1 : durationMs);
      return reply({ embeds: [new EmbedBuilder().setTitle('💎 Slot Code Generated').addFields({ name: 'Token', value: `\`${code}\``, inline: true }, { name: 'Duration', value: `\`${durationStr.toUpperCase()}\``, inline: true }).setColor(0x57F287)] });
    }

    if (commandName === 'gping') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) return reply({ embeds: [errorEmbed('Access Denied', 'Requires `Administrator` privileges.')], ephemeral: true });
      const type = interaction.options.getString('type');
      const amount = interaction.options.getInteger('amount');

      const code = generateCode('PING');
      db.prepare('INSERT INTO ping_codes (code, type, amount) VALUES (?, ?, ?)').run(code, type, amount);
      return reply({ embeds: [new EmbedBuilder().setTitle('🎫 Ping Code Generated').addFields({ name: 'Token', value: `\`${code}\``, inline: true }, { name: 'Target', value: `\`@${type}\``, inline: true }, { name: 'Credits', value: `\`${amount}\``, inline: true }).setColor(0xFEE75C)] });
    }

    if (commandName === 'setvouchchannel') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) return reply({ embeds: [errorEmbed('Access Denied', 'Requires `Administrator` privileges.')], ephemeral: true });
      const targetChan = interaction.options.getChannel('channel');
      db.prepare(`INSERT INTO guild_config (guild_id, vouch_channel_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET vouch_channel_id = excluded.vouch_channel_id`).run(guild.id, targetChan.id);
      return reply({ embeds: [new EmbedBuilder().setTitle('✅ Vouch Channel Set').setDescription(`Vouches restricted to ${targetChan}.`).setColor(0x57F287)] });
    }

    if (commandName === 'setvouchreaction') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) return reply({ embeds: [errorEmbed('Access Denied', 'Requires `Administrator` privileges.')], ephemeral: true });
      const emoji = interaction.options.getString('emoji');
      db.prepare(`INSERT INTO guild_config (guild_id, vouch_emoji) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET vouch_emoji = excluded.vouch_emoji`).run(guild.id, emoji);
      return reply({ embeds: [new EmbedBuilder().setTitle('✅ Vouch Emoji Updated').setDescription(`Reaction set to ${emoji}.`).setColor(0x57F287)] });
    }

    // Slot Commands
    const slot = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(user.id);

    if (commandName === 'title') {
      if (!slot) return reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')], ephemeral: true });
      if (channel.id !== slot.channel_id) return reply({ embeds: [errorEmbed('Restricted', 'Must be run in your slot channel.')], ephemeral: true });
      const newTitle = interaction.options.getString('text');
      db.prepare('UPDATE active_slots SET title = ? WHERE user_id = ?').run(newTitle, user.id);
      return reply({ embeds: [new EmbedBuilder().setTitle('✅ Title Updated').setDescription(`Title set to: **${newTitle}**`).setColor(0x57F287)] });
    }

    if (commandName === 'desc') {
      if (!slot) return reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')], ephemeral: true });
      if (channel.id !== slot.channel_id) return reply({ embeds: [errorEmbed('Restricted', 'Must be run in your slot channel.')], ephemeral: true });
      const newDesc = interaction.options.getString('text');
      db.prepare('UPDATE active_slots SET description = ? WHERE user_id = ?').run(newDesc, user.id);
      return reply({ embeds: [new EmbedBuilder().setTitle('✅ Description Updated').setDescription(`Description set to:\n\`\`\`${newDesc}\`\`\``).setColor(0x57F287)] });
    }

    if (commandName === 'renameslot') {
      if (!slot) return reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')], ephemeral: true });
      if (channel.id !== slot.channel_id) return reply({ embeds: [errorEmbed('Restricted', 'Must be run in your slot channel.')], ephemeral: true });
      const rawName = interaction.options.getString('name');
      const cleanName = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '');
      await channel.setName(`〢⤷slot-${cleanName}`);
      return reply({ embeds: [new EmbedBuilder().setTitle('🏷️ Channel Renamed').setDescription(`Renamed to \`〢⤷slot-${cleanName}\``).setColor(0x57F287)] });
    }

    if (commandName === 'stats') {
      if (!slot) return reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')], ephemeral: true });
      if (channel.id !== slot.channel_id) return reply({ embeds: [errorEmbed('Restricted', 'Must be run in your slot channel.')], ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle(`📊 Slot Statistics — ${user.username}`)
        .addFields(
          { name: 'Expiration', value: slot.expires_at === -1 ? '`Never (Lifetime)`' : `<t:${Math.floor(slot.expires_at / 1000)}:R>`, inline: true },
          { name: 'Ping Credits', value: `\`${slot.here_pings}x @here\` | \`${slot.everyone_pings}x @everyone\``, inline: true },
          { name: 'Custom Title', value: `\`${slot.title}\``, inline: false },
          { name: 'Custom Description', value: `\`\`\`${slot.description}\`\`\``, inline: false }
        ).setColor(0x5865F2);
      return reply({ embeds: [embed] });
    }

    if (commandName === 'nuke') {
      if (!slot) return reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')], ephemeral: true });
      if (channel.id !== slot.channel_id) return reply({ embeds: [errorEmbed('Restricted', 'Must be run in your slot channel.')], ephemeral: true });

      await reply({ content: '💥 Nuking channel...', ephemeral: true });
      const pos = channel.position;
      const newChan = await channel.clone();
      await channel.delete();
      await newChan.setPosition(pos);
      db.prepare('UPDATE active_slots SET channel_id = ? WHERE user_id = ?').run(newChan.id, user.id);
      return newChan.send({ embeds: [new EmbedBuilder().setTitle('💥 Channel Cleared').setDescription('Slot channel has been wiped clean.').setColor(0x57F287)] });
    }

    if (commandName === 'here' || commandName === 'everyone') {
      if (!slot) return reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')], ephemeral: true });
      if (channel.id !== slot.channel_id) return reply({ embeds: [errorEmbed('Restricted', 'Pings must be sent inside your slot channel.')], ephemeral: true });
      const messageText = interaction.options.getString('message');
      const colName = commandName === 'here' ? 'here_pings' : 'everyone_pings';

      if (slot[colName] <= 0) return reply({ embeds: [errorEmbed('Insufficient Balance', `You have **0** \`@${commandName}\` credits remaining.`)], ephemeral: true });

      db.prepare(`UPDATE active_slots SET ${colName} = ${colName} - 1 WHERE user_id = ?`).run(user.id);
      await reply({ content: 'Ping sent!', ephemeral: true });
      return channel.send({ content: `@${commandName} ${messageText}`, allowedMentions: { parse: [commandName] } });
    }

    // Vouch Commands
    if (commandName === 'vouch') {
      const config = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guild.id);
      if (config && config.vouch_channel_id && channel.id !== config.vouch_channel_id) {
        return reply({ embeds: [errorEmbed('Wrong Channel', `Vouches allowed only in <#${config.vouch_channel_id}>.`)], ephemeral: true });
      }

      const target = interaction.options.getUser('user');
      const comment = interaction.options.getString('comment');

      if (target.id === user.id) return reply({ embeds: [errorEmbed('Self-Vouch Denied', 'You cannot vouch for yourself.')], ephemeral: true });

      db.prepare('INSERT INTO vouches (target_id, author_id, comment, timestamp) VALUES (?, ?, ?, ?)').run(target.id, user.id, comment, Date.now());
      const total = db.prepare('SELECT COUNT(*) as count FROM vouches WHERE target_id = ?').get(target.id).count;

      const embed = new EmbedBuilder()
        .setTitle('⭐ Vouch Recorded')
        .addFields({ name: 'Merchant', value: `${target}`, inline: true }, { name: 'From', value: `${user}`, inline: true }, { name: 'Comment', value: `\`\`\`${comment}\`\`\`` })
        .setFooter({ text: `Total Vouches: ${total}` })
        .setColor(0x57F287);

      await reply({ content: 'Vouch submitted!', ephemeral: true });
      const vouchMsg = await channel.send({ embeds: [embed] });
      const reactionEmoji = config?.vouch_emoji || '⭐';
      try { await vouchMsg.react(reactionEmoji); } catch (err) {}
      return;
    }

    if (commandName === 'vouches') {
      const target = interaction.options.getUser('user') || user;
      const records = db.prepare('SELECT * FROM vouches WHERE target_id = ? ORDER BY timestamp DESC LIMIT 5').all(target.id);
      const total = db.prepare('SELECT COUNT(*) as count FROM vouches WHERE target_id = ?').get(target.id).count;

      if (records.length === 0) return reply({ embeds: [errorEmbed('No History', `${target.username} has 0 vouches.`)], ephemeral: true });

      const list = records.map((r, i) => `**#${i + 1}** by <@${r.author_id}> (<t:${Math.floor(r.timestamp / 1000)}:R>)\n└ *"${r.comment}"*`).join('\n\n');
      return reply({ embeds: [new EmbedBuilder().setTitle(`📋 Vouches — ${target.username}`).setDescription(list).setFooter({ text: `Total Vouches: ${total}` }).setColor(0x5865F2)] });
    }
  }

  // Buttons & Modals
  if (interaction.isButton()) {
    if (interaction.customId === 'btn_claim_slot') {
      const modal = new ModalBuilder().setCustomId('mdl_claim_slot').setTitle('Activate Slot Token');
      const input = new TextInputBuilder().setCustomId('inp_slot_code').setLabel('Slot Key').setStyle(TextInputStyle.Short).setPlaceholder('SLOT-XXXXXX').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'btn_claim_ping') {
      const modal = new ModalBuilder().setCustomId('mdl_claim_ping').setTitle('Redeem Ping Token');
      const input = new TextInputBuilder().setCustomId('inp_ping_code').setLabel('Ping Key').setStyle(TextInputStyle.Short).setPlaceholder('PING-XXXXXX').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'mdl_claim_slot') {
      const code = interaction.fields.getTextInputValue('inp_slot_code').trim();
      const codeData = db.prepare('SELECT * FROM slot_codes WHERE code = ? AND used = 0').get(code);

      if (!codeData) return interaction.reply({ embeds: [errorEmbed('Verification Failed', 'Invalid or claimed key.')], ephemeral: true });

      const existing = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(interaction.user.id);
      if (existing) return interaction.reply({ embeds: [errorEmbed('Limit Reached', 'You already operate an active slot channel.')], ephemeral: true });

      db.prepare('UPDATE slot_codes SET used = 1 WHERE code = ?').run(code);
      const expiresAt = codeData.durationMs === -1 ? -1 : Date.now() + codeData.durationMs;

      const channel = await interaction.guild.channels.create({
        name: `` + `〢⤷slot-${interaction.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: interaction.guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] }
        ]
      });

      db.prepare('INSERT INTO active_slots (user_id, channel_id, expires_at) VALUES (?, ?, ?)').run(interaction.user.id, channel.id, expiresAt);
      await interaction.reply({ content: `✅ **Slot Allocated!** Channel: ${channel}`, ephemeral: true });

      const welcomeEmbed = new EmbedBuilder()
        .setTitle(`🔒 Authorized Merchant Channel`)
        .setDescription(`Welcome <@${interaction.user.id}>! This is your dedicated slot channel.`)
        .addFields(
          { name: '👤 Owner', value: `<@${interaction.user.id}>`, inline: true },
          { name: '⏳ Expiration', value: expiresAt === -1 ? '`Never (Lifetime)`' : `<t:${Math.floor(expiresAt / 1000)}:R>`, inline: true },
          { name: '🎟️ Ping Balance', value: '`0x @here` | `0x @everyone`', inline: true }
        ).setColor(0x57F287);

      return channel.send({ content: `<@${interaction.user.id}>`, embeds: [welcomeEmbed] });
    }

    if (interaction.customId === 'mdl_claim_ping') {
      const code = interaction.fields.getTextInputValue('inp_ping_code').trim();
      const pingData = db.prepare('SELECT * FROM ping_codes WHERE code = ? AND used = 0').get(code);

      if (!pingData) return interaction.reply({ embeds: [errorEmbed('Verification Failed', 'Invalid key.')], ephemeral: true });

      const slot = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(interaction.user.id);
      if (!slot) return interaction.reply({ embeds: [errorEmbed('Active Slot Required', 'You must possess an active slot.')], ephemeral: true });

      db.prepare('UPDATE ping_codes SET used = 1 WHERE code = ?').run(code);
      const field = pingData.type === 'here' ? 'here_pings' : 'everyone_pings';
      db.prepare(`UPDATE active_slots SET ${field} = ${field} + ? WHERE user_id = ?`).run(pingData.amount, interaction.user.id);

      const updatedSlot = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(interaction.user.id);
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🎟️ Pings Added').setDescription(`Added **${pingData.amount}x @${pingData.type}** mentions.`).setColor(0x57F287)], ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
