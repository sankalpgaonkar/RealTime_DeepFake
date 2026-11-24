/**
 * Authentication Service
 * Handles user authentication, JWT token generation, and validation
 */

import jwt from 'jsonwebtoken';
import User from '../users/user.model.js';
import { ROLES } from '../security/rbac.js';
import config from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * Generate JWT token for user
 * @param {Object} user - User object
 * @returns {string} JWT token
 */
export const generateToken = (user) => {
  const payload = {
    id: user._id.toString(),
    email: user.email,
    operativeId: user.operativeId,
    role: user.role,
  };

  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
};

/**
 * Verify JWT token
 * @param {string} token - JWT token
 * @returns {Object} Decoded token payload
 */
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (error) {
    logger.error('Token verification failed:', error.message);
    throw new Error('Invalid or expired token');
  }
};

/**
 * Authenticate user with email and password
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Object} User object and token
 */
export const authenticateUser = async (email, password) => {
  try {
    const normalizedEmail = (email || '').toLowerCase().trim();
    const adminEmail = (config.admin?.email || process.env.ADMIN_EMAIL || 'sankalpgaonkar23@gmail.com').toLowerCase().trim();
    const adminPassword = config.admin?.defaultPassword || process.env.ADMIN_PASSWORD || 'Admin@123';

    // Find user and include password field
    let user = await User.findOne({ email: normalizedEmail }).select('+password');

    // Self-healing: if designated admin attempts to login and user does not exist yet, bootstrap immediately
    if (!user && normalizedEmail === adminEmail) {
      logger.info(`[AUTH] Admin ${adminEmail} not found during login; auto-bootstrapping account...`);
      const { bootstrapDefaultAdmin } = await import('../users/user.service.js');
      await bootstrapDefaultAdmin();
      user = await User.findOne({ email: adminEmail }).select('+password');
    }
    
    if (!user) {
      throw new Error('Invalid credentials');
    }

    if (!user.isActive) {
      throw new Error('Account is deactivated');
    }

    // Compare password
    let isPasswordValid = await user.comparePassword(password);

    // Self-healing: if password check fails for the designated admin with the configured admin password, repair and re-authenticate
    if (!isPasswordValid && normalizedEmail === adminEmail && password === adminPassword) {
      logger.info(`[AUTH] Synchronizing password for admin ${adminEmail}...`);
      const { bootstrapDefaultAdmin } = await import('../users/user.service.js');
      await bootstrapDefaultAdmin();
      user = await User.findOne({ email: adminEmail }).select('+password');
      isPasswordValid = await user.comparePassword(password);
    }

    if (!isPasswordValid) {
      throw new Error('Invalid credentials');
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    // Generate token
    const token = generateToken(user);

    // Return user without password
    const userObj = user.toJSON();

    logger.info(`User authenticated: ${user.operativeId} (${user.email})`);

    return {
      user: userObj,
      token,
    };
  } catch (error) {
    logger.error('Authentication error:', error);
    throw error;
  }
};

/**
 * Register a new user
 * @param {string} email - User email
 * @param {string} password - User password
 * @param {string} operativeId - Optional operative ID (auto-generated if not provided)
 * @returns {Object} User object and token
 */
export const registerUser = async (email, password, operativeId = null) => {
  try {
    const normalizedEmail = (email || '').toLowerCase().trim();
    const adminEmail = (config.admin?.email || process.env.ADMIN_EMAIL || 'sankalpgaonkar23@gmail.com').toLowerCase().trim();
    const isAdmin = normalizedEmail === adminEmail;

    // Check if user already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      throw new Error('User with this email already exists');
    }

    // If registering as designated admin, demote any other conflicting admin
    if (isAdmin) {
      await User.updateMany(
        { role: ROLES.ADMIN, email: { $ne: adminEmail } },
        { $set: { role: ROLES.OPERATIVE } }
      );
    }

    // Generate operative ID if not provided
    if (!operativeId) {
      if (isAdmin) {
        operativeId = config.admin?.operativeId || 'ADMIN_1';
      } else {
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = Math.random().toString(36).substring(2, 6).toUpperCase();
        operativeId = `USER_${timestamp}_${random}`;
      }
    } else {
      // Check if operative ID already exists
      const existingOperativeId = await User.findOne({ operativeId: operativeId.toUpperCase() });
      if (existingOperativeId) {
        throw new Error('Operative ID already exists');
      }
    }

    // Create new user
    const user = new User({
      email: normalizedEmail,
      password,
      operativeId: operativeId.toUpperCase(),
      role: isAdmin ? ROLES.ADMIN : ROLES.OPERATIVE,
      isActive: true,
      authProvider: 'local',
      metadata: isAdmin ? {
        firstName: 'Sankalp',
        lastName: 'Gaonkar',
        department: 'Security & Intelligence',
        clearanceLevel: 'TOP_SECRET',
      } : undefined,
    });

    await user.save();

    // Generate token
    const token = generateToken(user);

    logger.info(`User registered: ${user.operativeId} (${user.email})`);

    return {
      user: user.toJSON(),
      token,
    };
  } catch (error) {
    logger.error('Registration error:', error);
    throw error;
  }
};

/**
 * Get user by ID
 * @param {string} userId - User ID
 * @returns {Object} User object
 */
export const getUserById = async (userId) => {
  try {
    const user = await User.findById(userId);
    if (!user || !user.isActive) {
      throw new Error('User not found or inactive');
    }
    return user.toJSON();
  } catch (error) {
    logger.error('Get user error:', error);
    throw error;
  }
};

/**
 * Update user profile information
 * @param {string} userId - User ID
 * @param {Object} profileData - Profile data to update (firstName, lastName, department)
 * @returns {Object} Updated user object
 */
export const updateProfile = async (userId, profileData) => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Only allow updating metadata fields, not sensitive ones
    const { firstName, lastName, department } = profileData;

    if (firstName) user.metadata.firstName = firstName;
    if (lastName) user.metadata.lastName = lastName;
    if (department) user.metadata.department = department;

    await user.save({ validateBeforeSave: false });

    logger.info(`User profile updated: ${user.operativeId}`);

    return user.toJSON();
  } catch (error) {
    logger.error('Update profile error:', error);
    throw error;
  }
};

/**
 * Change user password
 * @param {string} userId - User ID
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 * @returns {Object} Success response
 */
export const changePassword = async (userId, currentPassword, newPassword) => {
  try {
    const user = await User.findById(userId).select('+password');
    if (!user) {
      throw new Error('User not found');
    }

    // Block password change for Google OAuth users
    if (user.authProvider === 'google') {
      throw new Error('Password management is handled by Google. Please use Google account settings.');
    }

    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      throw new Error('Current password is incorrect');
    }

    // Check if new password is different from current
    const isSamePassword = await user.comparePassword(newPassword);
    if (isSamePassword) {
      throw new Error('New password must be different from current password');
    }

    // Validate password length
    if (newPassword.length < 6) {
      throw new Error('New password must be at least 6 characters');
    }

    // Set new password (pre-save hook will hash it)
    user.password = newPassword;
    await user.save({ validateBeforeSave: false });

    logger.info(`Password changed for user: ${user.operativeId}`);

    return {
      success: true,
      message: 'Password changed successfully',
    };
  } catch (error) {
    logger.error('Change password error:', error);
    throw error;
  }
};

/**
 * Update notification preferences
 * @param {string} userId - User ID
 * @param {Object} preferences - Notification preferences
 * @returns {Object} Updated preferences
 */
export const updateNotificationPreferences = async (userId, preferences) => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Update notification preferences
    const {
      emailEnabled,
      emailOnDeepfake,
      emailOnAll,
      inAppEnabled,
    } = preferences;

    if (emailEnabled !== undefined) user.notificationPreferences.emailEnabled = emailEnabled;
    if (emailOnDeepfake !== undefined) user.notificationPreferences.emailOnDeepfake = emailOnDeepfake;
    if (emailOnAll !== undefined) user.notificationPreferences.emailOnAll = emailOnAll;
    if (inAppEnabled !== undefined) user.notificationPreferences.inAppEnabled = inAppEnabled;

    await user.save({ validateBeforeSave: false });

    logger.info(`Notification preferences updated for user: ${user.operativeId}`);

    return {
      success: true,
      data: user.notificationPreferences,
    };
  } catch (error) {
    logger.error('Update notification preferences error:', error);
    throw error;
  }
};

export default {
  generateToken,
  verifyToken,
  authenticateUser,
  registerUser,
  getUserById,
  updateProfile,
  changePassword,
  updateNotificationPreferences,
};

