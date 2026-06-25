import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../config/database";

interface BrandSettingsAttributes {
  id: number;
  brandName: string;
  heroText: string;
  tagline: string;
  cartNotice: string;
  footerNote: string;
  logoUrl: string;
}

interface BrandSettingsCreationAttributes extends Optional<
  BrandSettingsAttributes,
  "logoUrl"
> {}

export class BrandSettings
  extends Model<BrandSettingsAttributes, BrandSettingsCreationAttributes>
  implements BrandSettingsAttributes
{
  declare id: number;
  declare brandName: string;
  declare heroText: string;
  declare tagline: string;
  declare cartNotice: string;
  declare footerNote: string;
  declare logoUrl: string;
}

BrandSettings.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      defaultValue: 1,
    },
    brandName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    heroText: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    tagline: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    cartNotice: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    footerNote: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    logoUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "brand_settings",
    timestamps: true,
  },
);
