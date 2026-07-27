import { DataTypes, Model, Op, Optional } from "sequelize";
import { sequelize } from "../config/database";
import type { ProductSize } from "./ProductSize";

/** Imagen de producto en Cloudinary: URL pública + public_id para poder borrarla. */
export interface ProductImage {
  url: string;
  publicId: string;
}

export interface ProductAttributes {
  id: number;
  name: string;
  description?: string;
  originalPrice: number;
  salePrice: number;
  readonly discountPercent: number;
  unitCost: number;
  readonly stock: number;
  type: "bota" | "sombrero" | "ropa";
  readonly sizes: number[];
  readonly imageSrc: string | null;
  images: ProductImage[];
  code?: string;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  visible: boolean;
  deletedAt?: Date | null;
}

interface ProductCreationAttributes extends Optional<
  ProductAttributes,
  "id" | "description" | "imageSrc" | "images" | "code" | "discountPercent" | "stock" | "sizes" | "deletedAt"
> {}

export class Product
  extends Model<ProductAttributes, ProductCreationAttributes>
  implements ProductAttributes
{
  declare id: number;
  declare name: string;
  declare description?: string;
  declare originalPrice: number;
  declare salePrice: number;
  declare readonly discountPercent: number;
  declare unitCost: number;
  declare readonly stock: number;
  declare type: "bota" | "sombrero" | "ropa";
  declare readonly sizes: number[];
  declare readonly imageSrc: string | null;
  declare images: ProductImage[];
  declare code?: string;
  declare weightKg: number;
  declare lengthCm: number;
  declare widthCm: number;
  declare heightCm: number;
  declare visible: boolean;
  declare deletedAt?: Date | null;
  declare productSizes?: ProductSize[];

  toJSON() {
    const values = { ...this.get() } as Record<string, unknown>;
    delete values.productSizes;
    return values;
  }
}

Product.init(
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
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    originalPrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("originalPrice");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    salePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("salePrice");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    discountPercent: {
      type: DataTypes.VIRTUAL,
      get() {
        const originalPrice = this.getDataValue("originalPrice") as unknown as number;
        const salePrice = this.getDataValue("salePrice") as unknown as number;
        if (!originalPrice) return 0;
        return Math.round(
          ((parseFloat(originalPrice as unknown as string) -
            parseFloat(salePrice as unknown as string)) /
            parseFloat(originalPrice as unknown as string)) *
            100,
        );
      },
    },
    unitCost: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("unitCost");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    stock: {
      type: DataTypes.VIRTUAL,
      get(this: Product) {
        const productSizes = this.productSizes;
        if (!productSizes) return 0;
        return productSizes.reduce((acc, ps) => acc + ps.stock, 0);
      },
    },
    type: {
      type: DataTypes.ENUM("bota", "sombrero", "ropa"),
      allowNull: false,
    },
    sizes: {
      type: DataTypes.VIRTUAL,
      get(this: Product) {
        const productSizes = this.productSizes;
        if (!productSizes) return [];
        return productSizes.flatMap((ps) => Array(ps.stock).fill(ps.size));
      },
    },
    imageSrc: {
      // Derivado de images[0].url (primera imagen). VIRTUAL de solo lectura por
      // compatibilidad con los consumidores del front que leen `imageSrc`: la
      // fuente de verdad es `images`, así no hay columna física que sincronizar.
      type: DataTypes.VIRTUAL,
      get(this: Product) {
        const images = this.getDataValue("images");
        return images?.[0]?.url ?? null;
      },
    },
    images: {
      // Galería de hasta 3 imágenes en Cloudinary: [{ url, publicId }]. El
      // public_id es lo que uploader.destroy necesita para borrar el asset.
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    weightKg: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    lengthCm: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    widthCm: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    heightCm: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    visible: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    sequelize,
    tableName: "products",
    timestamps: true,
    indexes: [
      {
        unique: true,
        name: "products_code_unique",
        fields: ["code"],
        // Índice único parcial: `code` puede estar en blanco (v. migración
        // 20260727120000-products-code-unique-index.ts). Declarado también aquí porque
        // tests/setup/db.ts construye el esquema con sequelize.sync({ force: true }), no con
        // migraciones.
        where: { [Op.and]: [{ code: { [Op.ne]: null } }, { code: { [Op.ne]: "" } }] },
      },
    ],
  },
);
