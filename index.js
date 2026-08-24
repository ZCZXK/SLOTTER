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
  PermissionFlagsBits 
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

client.once('ready', () => {
  console.log(`[SYSTEM] Logged in as ${client.user.tag}`);
  client.user.setActivity('Slot Management | $setup', { type: 3 });

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

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ADMIN COMMANDS
  if (command === 'setup') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply({ embeds: [errorEmbed('Access Denied', 'You require `Administrator` privileges.')] });
    }

    const slotPanel = new EmbedBuilder()
      .setTitle('⚡ VIP Slot Management')
      .setDescription('Claim your dedicated text channel by activating a valid slot token below.\n\n**Features Included:**\n• Custom branding (`〢⤷slot-username`)\n• Isolated messaging rights\n• Granular ping allocations')
      .setColor(0x2B2D31);

    const slotRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_claim_slot').setLabel('Activate Slot Token').setStyle(ButtonStyle.Success).setEmoji('🔑')
    );

    const pingPanel = new EmbedBuilder()
      .setTitle('🔔 Audience Reach Credits')
      .setDescription('Redeem additional announcement pings (`@here` / `@everyone`) for your active slot channel.')
      .setColor(0x2B2D31);

    const pingRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_claim_ping').setLabel('Redeem Ping Token').setStyle(ButtonStyle.Primary).setEmoji('🎟️')
    );

    await message.channel.send({ embeds: [slotPanel], components: [slotRow] });
    await message.channel.send({ embeds: [pingPanel], components: [pingRow] });
    if (message.deletable) await message.delete();
  }

  if (command === 'gslot') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
    const durationStr = args[0];
    const durationMs = parseDuration(durationStr || '');
    if (!durationMs) return message.reply({ embeds: [errorEmbed('Invalid Parameters', 'Syntax: `$gslot <1w|1m|3m|lifetime>`')] });

    const code = generateCode('SLOT');
    db.prepare('INSERT INTO slot_codes (code, durationMs) VALUES (?, ?)').run(code, durationMs === Infinity ? -1 : durationMs);

    return message.reply({ embeds: [new EmbedBuilder().setTitle('💎 Slot Code Generated').addFields({ name: 'Token', value: `\`${code}\``, inline: true }, { name: 'Duration', value: `\`${durationStr.toUpperCase()}\``, inline: true }).setColor(0x57F287)] });
  }

  if (command === 'gping') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
    const type = args[0]?.toLowerCase();
    const amount = parseInt(args[1]);
    if (!['here', 'everyone'].includes(type) || isNaN(amount) || amount <= 0) {
      return message.reply({ embeds: [errorEmbed('Invalid Parameters', 'Syntax: `$gping <here|everyone> <amount>`')] });
    }

    const code = generateCode('PING');
    db.prepare('INSERT INTO ping_codes (code, type, amount) VALUES (?, ?, ?)').run(code, type, amount);

    return message.reply({ embeds: [new EmbedBuilder().setTitle('🎫 Ping Code Generated').addFields({ name: 'Token', value: `\`${code}\``, inline: true }, { name: 'Target', value: `\`@${type}\``, inline: true }, { name: 'Credits', value: `\`${amount}\``, inline: true }).setColor(0xFEE75C)] });
  }

  if (command === 'setvouchchannel') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply({ embeds: [errorEmbed('Access Denied', 'Requires `Administrator` privileges.')] });
    }

    const channel = message.mentions.channels.first();
    if (!channel) return message.reply({ embeds: [errorEmbed('Missing Channel', 'Syntax: `$setvouchchannel #channel`')] });

    db.prepare(`
      INSERT INTO guild_config (guild_id, vouch_channel_id) 
      VALUES (?, ?) 
      ON CONFLICT(guild_id) DO UPDATE SET vouch_channel_id = excluded.vouch_channel_id
    `).run(message.guild.id, channel.id);

    return message.reply({ embeds: [new EmbedBuilder().setTitle('✅ Vouch Channel Set').setDescription(`Vouches are now restricted to ${channel}.`).setColor(0x57F287)] });
  }

  if (command === 'setvouchreaction') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply({ embeds: [errorEmbed('Access Denied', 'Requires `Administrator` privileges.')] });
    }

    const emoji = args[0];
    if (!emoji) return message.reply({ embeds: [errorEmbed('Missing Emoji', 'Syntax: `$setvouchreaction <emoji>`')] });

    db.prepare(`
      INSERT INTO guild_config (guild_id, vouch_emoji) 
      VALUES (?, ?) 
      ON CONFLICT(guild_id) DO UPDATE SET vouch_emoji = excluded.vouch_emoji
    `).run(message.guild.id, emoji);

    return message.reply({ embeds: [new EmbedBuilder().setTitle('✅ Vouch Emoji Updated').setDescription(`Bot will now react with ${emoji} on new vouches.`).setColor(0x57F287)] });
  }

  // SLOT OWNER COMMANDS
  const slot = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(message.author.id);

  if (command === 'title') {
    if (!slot) return message.reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')] });
    if (message.channel.id !== slot.channel_id) return message.reply({ embeds: [errorEmbed('Restricted', 'Must be executed inside your slot channel.')] });

    const newTitle = args.join(' ');
    if (!newTitle) return message.reply({ embeds: [errorEmbed('Missing Payload', 'Syntax: `$title <new title>`')] });

    db.prepare('UPDATE active_slots SET title = ? WHERE user_id = ?').run(newTitle, message.author.id);
    return message.reply({ embeds: [new EmbedBuilder().setTitle('✅ Title Updated').setDescription(`Channel Title set to: **${newTitle}**`).setColor(0x57F287)] });
  }

  if (command === 'desc') {
    if (!slot) return message.reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')] });
    if (message.channel.id !== slot.channel_id) return message.reply({ embeds: [errorEmbed('Restricted', 'Must be executed inside your slot channel.')] });

    const newDesc = args.join(' ');
    if (!newDesc) return message.reply({ embeds: [errorEmbed('Missing Payload', 'Syntax: `$desc <new description>`')] });

    db.prepare('UPDATE active_slots SET description = ? WHERE user_id = ?').run(newDesc, message.author.id);
    return message.reply({ embeds: [new EmbedBuilder().setTitle('✅ Description Updated').setDescription(`Description set to:\n\`\`\`${newDesc}\`\`\``).setColor(0x57F287)] });
  }

  if (command === 'renameslot') {
    if (!slot) return message.reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')] });
    if (message.channel.id !== slot.channel_id) return message.reply({ embeds: [errorEmbed('Restricted', 'Must be executed inside your slot channel.')] });

    const newName = args.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!newName) return message.reply({ embeds: [errorEmbed('Missing Name', 'Syntax: `$renameslot <channel-name>`')] });

    await message.channel.setName(`〢⤷slot-${newName}`);
    return message.reply({ embeds: [new EmbedBuilder().setTitle('🏷️ Channel Renamed').setDescription(`Renamed to \`〢⤷slot-${newName}\``).setColor(0x57F287)] });
  }

  if (command === 'stats') {
    if (!slot) return message.reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')] });
    if (message.channel.id !== slot.channel_id) return message.reply({ embeds: [errorEmbed('Restricted', 'Must be executed inside your slot channel.')] });

    const embed = new EmbedBuilder()
      .setTitle(`📊 Slot Statistics — ${message.author.username}`)
      .addFields(
        { name: 'Expiration', value: slot.expires_at === -1 ? '`Never (Lifetime)`' : `<t:${Math.floor(slot.expires_at / 1000)}:R>`, inline: true },
        { name: 'Ping Credits', value: `\`${slot.here_pings}x @here\` | \`${slot.everyone_pings}x @everyone\``, inline: true },
        { name: 'Custom Title', value: `\`${slot.title}\``, inline: false },
        { name: 'Custom Description', value: `\`\`\`${slot.description}\`\`\``, inline: false }
      )
      .setColor(0x5865F2);

    return message.reply({ embeds: [embed] });
  }

  if (command === 'nuke') {
    if (!slot) return message.reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')] });
    if (message.channel.id !== slot.channel_id) return message.reply({ embeds: [errorEmbed('Restricted', 'Must be executed inside your slot channel.')] });

    const position = message.channel.position;
    const newChannel = await message.channel.clone();
    await message.channel.delete();

    await newChannel.setPosition(position);
    db.prepare('UPDATE active_slots SET channel_id = ? WHERE user_id = ?').run(newChannel.id, message.author.id);

    return newChannel.send({ embeds: [new EmbedBuilder().setTitle('💥 Channel Cleared').setDescription('Slot channel has been wiped clean.').setColor(0x57F287)] });
  }

  if (command === 'here' || command === 'everyone') {
    if (!slot) return message.reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')] });
    if (message.channel.id !== slot.channel_id) return message.reply({ embeds: [errorEmbed('Restricted', 'Pings must be dispatched inside your slot channel.')] });

    const content = args.join(' ');
    if (!content) return message.reply({ embeds: [errorEmbed('Missing Payload', `Syntax: \`$${command} <message>\``)] });

    const colName = command === 'here' ? 'here_pings' : 'everyone_pings';
    if (slot[colName] <= 0) return message.reply({ embeds: [errorEmbed('Insufficient Balance', `You have **0** \`@${command}\` credits remaining.`)] });

    db.prepare(`UPDATE active_slots SET ${colName} = ${colName} - 1 WHERE user_id = ?`).run(message.author.id);

    await message.channel.send({ content: `@${command} ${content}`, allowedMentions: { parse: [command] } });
    if (message.deletable) await message.delete();
  }

  // VOUCH COMMANDS
  if (command === 'vouch') {
    const config = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(message.guild.id);

    if (config && config.vouch_channel_id && message.channel.id !== config.vouch_channel_id) {
      if (message.deletable) await message.delete();
      const warning = await message.channel.send({ embeds: [errorEmbed('Wrong Channel', `Vouches can only be posted in <#${config.vouch_channel_id}>.`)] });
      setTimeout(() => warning.delete().catch(() => {}), 5000);
      return;
    }

    const target = message.mentions.users.first();
    const comment = args.slice(1).join(' ');

    if (!target || !comment) return message.reply({ embeds: [errorEmbed('Invalid Format', 'Syntax: `$vouch @user <comment>`')] });
    if (target.id === message.author.id) return message.reply({ embeds: [errorEmbed('Self-Vouch Denied', 'You cannot vouch for yourself.')] });

    db.prepare('INSERT INTO vouches (target_id, author_id, comment, timestamp) VALUES (?, ?, ?, ?)').run(target.id, message.author.id, comment, Date.now());
    const total = db.prepare('SELECT COUNT(*) as count FROM vouches WHERE target_id = ?').get(target.id).count;

    const embed = new EmbedBuilder()
      .setTitle('⭐ Vouch Recorded')
      .addFields({ name: 'Merchant', value: `${target}`, inline: true }, { name: 'From', value: `${message.author}`, inline: true }, { name: 'Comment', value: `\`\`\`${comment}\`\`\`` })
      .setFooter({ text: `Total Vouches: ${total}` })
      .setColor(0x57F287);

    const vouchMsg = await message.channel.send({ embeds: [embed] });
    const reactionEmoji = config?.vouch_emoji || '⭐';
    try { await vouchMsg.react(reactionEmoji); } catch (err) {}
  }

  if (command === 'vouches') {
    const target = message.mentions.users.first() || message.author;
    const records = db.prepare('SELECT * FROM vouches WHERE target_id = ? ORDER BY timestamp DESC LIMIT 5').all(target.id);
    const total = db.prepare('SELECT COUNT(*) as count FROM vouches WHERE target_id = ?').get(target.id).count;

    if (records.length === 0) return message.reply({ embeds: [errorEmbed('No History', `${target.username} has received 0 vouches.`)] });

    const list = records.map((r, i) => `**#${i + 1}** by <@${r.author_id}> (<t:${Math.floor(r.timestamp / 1000)}:R>)\n└ *"${r.comment}"*`).join('\n\n');
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle(`📋 Vouches — ${target.username}`).setDescription(list).setFooter({ text: `Total Vouches: ${total}` }).setColor(0x5865F2)] });
  }
});

// INTERACTION HANDLERS
client.on('interactionCreate', async (interaction) => {
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
      const guild = interaction.guild;

      const channel = await guild.channels.create({
        name: `〢⤷slot-${interaction.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] }
        ]
      });

      db.prepare('INSERT INTO active_slots (user_id, channel_id, expires_at) VALUES (?, ?, ?)').run(interaction.user.id, channel.id, expiresAt);

      await interaction.reply({ content: `✅ **Slot Allocated!** Access your channel: ${channel}`, ephemeral: true });

      const welcomeEmbed = new EmbedBuilder()
        .setTitle(`🔒 Authorized Merchant Channel`)
        .setDescription(`Welcome <@${interaction.user.id}>! This is your dedicated slot channel. You have exclusive posting rights here.`)
        .addFields(
          { name: '👤 Owner', value: `<@${interaction.user.id}>`, inline: true },
          { name: '⏳ Expiration', value: expiresAt === -1 ? '`Never (Lifetime)`' : `<t:${Math.floor(expiresAt / 1000)}:R>`, inline: true },
          { name: '🎟️ Ping Balance', value: '`0x @here` | `0x @everyone`', inline: true }
        ).setColor(0x57F287);

      const commandGuideEmbed = new EmbedBuilder()
        .setTitle('🛠️ Slot Owner Command Panel')
        .setDescription('Use these prefix commands (`$`) inside this channel to manage your slot and reach customers:')
        .addFields(
          { name: '📢 Announcement Commands', value: '• `$here <message>` — Dispatch an `@here` ping notification.\n• `$everyone <message>` — Dispatch an `@everyone` ping notification.' },
          { name: '⚙️ Channel Customization', value: '• `$title <text>` — Update your slot channel title.\n• `$desc <text>` — Update your store description.\n• `$renameslot <name>` — Change channel name (`〢⤷slot-name`).' },
          { name: '🧹 Management & Utilities', value: '• `$stats` — View your slot status, expiration, & ping credits.\n• `$nuke` — Wipe all messages and restart channel with fresh logs.' },
          { name: '⭐ Reputation & Vouches', value: '• `$vouch @user <comment>` — Record a customer review.\n• `$vouches [@user]` — Check total vouch count and feedback history.' }
        ).setFooter({ text: 'Tip: Redeem ping codes on the main panel to top up your ping balance.' }).setColor(0x5865F2);

      await channel.send({ content: `<@${interaction.user.id}>`, embeds: [welcomeEmbed, commandGuideEmbed] });
    }

    if (interaction.customId === 'mdl_claim_ping') {
      const code = interaction.fields.getTextInputValue('inp_ping_code').trim();
      const pingData = db.prepare('SELECT * FROM ping_codes WHERE code = ? AND used = 0').get(code);

      if (!pingData) return interaction.reply({ embeds: [errorEmbed('Verification Failed', 'Invalid or expired ping key.')], ephemeral: true });

      const slot = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(interaction.user.id);
      if (!slot) return interaction.reply({ embeds: [errorEmbed('Active Slot Required', 'You must possess an active slot to redeem pings.')], ephemeral: true });

      db.prepare('UPDATE ping_codes SET used = 1 WHERE code = ?').run(code);

      const field = pingData.type === 'here' ? 'here_pings' : 'everyone_pings';
      db.prepare(`UPDATE active_slots SET ${field} = ${field} + ? WHERE user_id = ?`).run(pingData.amount, interaction.user.id);

      const updatedSlot = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(interaction.user.id);

      const embed = new EmbedBuilder()
        .setTitle('🎟️ Ping Credits Deposited')
        .setDescription(`Added **${pingData.amount}x @${pingData.type}** mentions to your channel.`)
        .addFields({ name: 'Updated Balance', value: `\`${updatedSlot.here_pings}x @here\` | \`${updatedSlot.everyone_pings}x @everyone\`` })
        .setColor(0x57F287);

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);