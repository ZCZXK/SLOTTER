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
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Storage Maps (Note: In-memory maps reset when bot restarts. Use SQLite/MongoDB for persistence)
const slotCodes = new Map(); // code -> { durationMs, used: boolean }
const pingCodes = new Map(); // code -> { type: 'here' | 'everyone', amount: number, used: boolean }
const activeSlots = new Map(); // userId -> { channelId, expiresAt, herePings: number, everyonePings: number }

// Utility Functions
function parseDuration(durationStr) {
  switch (durationStr.toLowerCase()) {
    case '1w': return 7 * 24 * 60 * 60 * 1000;
    case '1m': return 30 * 24 * 60 * 60 * 1000;
    case '3m': return 90 * 24 * 60 * 60 * 1000;
    case 'lifetime': return Infinity;
    default: return null;
  }
}

function generateSlotCode() {
  return 'SLOT-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generatePingCode() {
  return 'PING-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Bot Startup & Command Registration
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    // Admin Commands
    new SlashCommandBuilder()
      .setName('setup-panels')
      .setDescription('Post the Slot and Ping activation panels')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('generate-slot')
      .setDescription('Generate a slot activation code')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(option =>
        option.setName('duration')
          .setDescription('Slot duration')
          .setRequired(true)
          .addChoices(
            { name: '1 Week', value: '1w' },
            { name: '1 Month', value: '1m' },
            { name: '3 Months', value: '3m' },
            { name: 'Lifetime', value: 'lifetime' }
          )
      ),

    new SlashCommandBuilder()
      .setName('generate-ping')
      .setDescription('Generate a ping activation code')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(option =>
        option.setName('type')
          .setDescription('Type of ping')
          .setRequired(true)
          .addChoices(
            { name: '@here Ping', value: 'here' },
            { name: '@everyone Ping', value: 'everyone' }
          )
      )
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Number of pings granted')
          .setRequired(true)
      ),

    // User Command
    new SlashCommandBuilder()
      .setName('use-ping')
      .setDescription('Use a ping inside your active slot channel')
      .addStringOption(option =>
        option.setName('type')
          .setDescription('Select ping type')
          .setRequired(true)
          .addChoices(
            { name: '@here Ping', value: 'here' },
            { name: '@everyone Ping', value: 'everyone' }
          )
      )
      .addStringOption(option =>
        option.setName('message')
          .setDescription('Announcement text to send')
          .setRequired(true)
      )
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('Slash commands loaded successfully.');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
});

// Interaction Handling (Slash Commands, Buttons, Modals)
client.on('interactionCreate', async (interaction) => {
  // -------------------------------------------------------------
  // 1. SLASH COMMANDS
  // -------------------------------------------------------------
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // Command: /setup-panels
    if (commandName === 'setup-panels') {
      const slotEmbed = new EmbedBuilder()
        .setTitle('⚡ Slot Redemption')
        .setDescription('Click below and enter your code to create your personal slot channel.')
        .setColor(0x5865F2);

      const slotRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('activate_slot_btn')
          .setLabel('Activate Slot')
          .setStyle(ButtonStyle.Success)
      );

      const pingEmbed = new EmbedBuilder()
        .setTitle('🔔 Ping Redemption')
        .setDescription('Click below and enter your ping code to add pings to your active slot.')
        .setColor(0xF1C40F);

      const pingRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('redeem_ping_btn')
          .setLabel('Redeem Ping Code')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.reply({ embeds: [slotEmbed, pingEmbed], components: [slotRow, pingRow] });
    }

    // Command: /generate-slot
    if (commandName === 'generate-slot') {
      const duration = interaction.options.getString('duration');
      const durationMs = parseDuration(duration);
      const code = generateSlotCode();

      slotCodes.set(code, { durationMs, used: false });

      await interaction.reply({
        content: `**Slot Code Generated!**\n**Code:** \`${code}\`\n**Duration:** ${duration}`,
        ephemeral: true
      });
    }

    // Command: /generate-ping
    if (commandName === 'generate-ping') {
      const type = interaction.options.getString('type');
      const amount = interaction.options.getInteger('amount');
      const code = generatePingCode();

      pingCodes.set(code, { type, amount, used: false });

      await interaction.reply({
        content: `**Ping Code Generated!**\n**Code:** \`${code}\`\n**Type:** @${type}\n**Amount:** ${amount}`,
        ephemeral: true
      });
    }

    // Command: /use-ping
    if (commandName === 'use-ping') {
      const slot = activeSlots.get(interaction.user.id);

      if (!slot) {
        return interaction.reply({ content: 'You do not own an active slot!', ephemeral: true });
      }

      if (interaction.channelId !== slot.channelId) {
        return interaction.reply({ content: 'You can only use pings inside your assigned slot channel!', ephemeral: true });
      }

      const type = interaction.options.getString('type');
      const message = interaction.options.getString('message');
      const pingKey = type === 'here' ? 'herePings' : 'everyonePings';
      const available = slot[pingKey] || 0;

      if (available <= 0) {
        return interaction.reply({
          content: `You have 0 **@${type}** pings remaining. Redeem a ping code first!`,
          ephemeral: true
        });
      }

      slot[pingKey] -= 1;

      await interaction.channel.send({
        content: `@${type} ${message}`,
        allowedMentions: { parse: [type] }
      });

      await interaction.reply({
        content: `Ping sent successfully! Remaining **@${type}** pings: ${slot[pingKey]}`,
        ephemeral: true
      });
    }
  }

  // -------------------------------------------------------------
  // 2. BUTTON CLICK HANDLERS
  // -------------------------------------------------------------
  if (interaction.isButton()) {
    // Open Slot Modal
    if (interaction.customId === 'activate_slot_btn') {
      const modal = new ModalBuilder()
        .setCustomId('slot_modal')
        .setTitle('Activate Your Slot');

      const input = new TextInputBuilder()
        .setCustomId('slot_code_input')
        .setLabel('Enter Slot Code')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('SLOT-XXXXXX')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }

    // Open Ping Modal
    if (interaction.customId === 'redeem_ping_btn') {
      const modal = new ModalBuilder()
        .setCustomId('ping_modal')
        .setTitle('Redeem Ping Code');

      const input = new TextInputBuilder()
        .setCustomId('ping_code_input')
        .setLabel('Enter Ping Code')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('PING-XXXXXX')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }
  }

  // -------------------------------------------------------------
  // 3. MODAL SUBMISSION HANDLERS
  // -------------------------------------------------------------
  if (interaction.isModalSubmit()) {
    // Redeem Slot Code
    if (interaction.customId === 'slot_modal') {
      const code = interaction.fields.getTextInputValue('slot_code_input').trim();
      const codeData = slotCodes.get(code);

      if (!codeData || codeData.used) {
        return interaction.reply({ content: 'Invalid or already redeemed slot code!', ephemeral: true });
      }

      codeData.used = true;

      const expiresAt = codeData.durationMs === Infinity ? Infinity : Date.now() + codeData.durationMs;
      const channelName = `〢⤷slot-${interaction.user.username}`;
      const guild = interaction.guild;

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: guild.id, // @everyone role (read-only)
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages]
          },
          {
            id: interaction.user.id, // Owner permissions
            allow: [
              PermissionFlagsBits.ViewChannel, 
              PermissionFlagsBits.SendMessages, 
              PermissionFlagsBits.EmbedLinks, 
              PermissionFlagsBits.AttachFiles
            ]
          }
        ]
      });

      activeSlots.set(interaction.user.id, {
        channelId: channel.id,
        expiresAt: expiresAt,
        herePings: 0,
        everyonePings: 0
      });

      await interaction.reply({
        content: `Slot created successfully! Head to ${channel}`,
        ephemeral: true
      });

      const welcomeEmbed = new EmbedBuilder()
        .setTitle(`Welcome to ${interaction.user.username}'s Slot`)
        .setDescription(`Expiration: ${expiresAt === Infinity ? 'Never (Lifetime)' : `<t:${Math.floor(expiresAt / 1000)}:R>`}`)
        .setColor(0x2ECC71);

      await channel.send({ content: `<@${interaction.user.id}>`, embeds: [welcomeEmbed] });
    }

    // Redeem Ping Code
    if (interaction.customId === 'ping_modal') {
      const code = interaction.fields.getTextInputValue('ping_code_input').trim();
      const pingData = pingCodes.get(code);

      if (!pingData || pingData.used) {
        return interaction.reply({ content: 'Invalid or already used ping code!', ephemeral: true });
      }

      const slot = activeSlots.get(interaction.user.id);
      if (!slot) {
        return interaction.reply({ content: 'You need an active slot to redeem ping codes!', ephemeral: true });
      }

      pingData.used = true;

      if (pingData.type === 'here') {
        slot.herePings = (slot.herePings || 0) + pingData.amount;
      } else {
        slot.everyonePings = (slot.everyonePings || 0) + pingData.amount;
      }

      await interaction.reply({
        content: `Code redeemed! Added **${pingData.amount}x @${pingData.type}** ping(s) to your account.\n**Balance:** ${slot.herePings}x @here | ${slot.everyonePings}x @everyone`,
        ephemeral: true
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
