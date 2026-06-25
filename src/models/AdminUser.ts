import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";

export interface AdminUserAttributes {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  role: "owner" | "admin";
}

interface AdminUserCreationAttributes
  extends Optional<AdminUserAttributes, "id" | "role"> {}

export class AdminUser
  extends Model<AdminUserAttributes, AdminUserCreationAttributes>
  implements AdminUserAttributes
{
  declare id: number;
  declare name: string;
  declare email: string;
  declare passwordHash: string;
  declare role: "owner" | "admin";
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
  },
  {
    sequelize,
    tableName: "adminusers",
    timestamps: true,
  },
);
