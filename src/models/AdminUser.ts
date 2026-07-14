import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";

export interface AdminUserAttributes {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  role: "owner" | "admin";
  // Flujo de recuperación de contraseña (Fase 9). El código nunca se guarda en
  // claro: solo su hash sha256. Nulos cuando no hay un reset en curso.
  resetPasswordCodeHash: string | null;
  resetPasswordExpiresAt: Date | null;
  resetPasswordAttempts: number;
}

interface AdminUserCreationAttributes
  extends Optional<
    AdminUserAttributes,
    | "id"
    | "role"
    | "resetPasswordCodeHash"
    | "resetPasswordExpiresAt"
    | "resetPasswordAttempts"
  > {}

export class AdminUser
  extends Model<AdminUserAttributes, AdminUserCreationAttributes>
  implements AdminUserAttributes
{
  declare id: number;
  declare name: string;
  declare email: string;
  declare passwordHash: string;
  declare role: "owner" | "admin";
  declare resetPasswordCodeHash: string | null;
  declare resetPasswordExpiresAt: Date | null;
  declare resetPasswordAttempts: number;
}

AdminUser.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM("owner", "admin"),
      allowNull: false,
      defaultValue: "admin",
    },
    resetPasswordCodeHash: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    resetPasswordExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    resetPasswordAttempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: "adminusers",
    timestamps: true,
  },
);
