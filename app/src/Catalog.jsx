import { useDeferredValue, useState } from "react";
import {
  Search,
  BookOpen,
  Languages,
  ShieldCheck,
  CircleAlert,
  Pencil,
  FolderOpen,
} from "lucide-react";
import {
  Badge,
  Empty,
  ExportButton,
  Field,
  Metric,
  Modal,
  Pagination,
} from "./shared";
import { downloadCsv, request } from "./api";

export default function Catalog({ data, run, busy }) {
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [stall, setStall] = useState("");
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [recipes, setRecipes] = useState([]);
  const [materials, setMaterials] = useState(null);
  const stalls = [...new Set(data.dishes.map((dish) => dish.stall))];
  const items = data.dishes.filter(
    (dish) =>
      (!stall || dish.stall === stall) &&
      (!missing || dish.spicy === "未知" || dish.vegetarian === "未知") &&
      `${dish.name} ${dish.english}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / 12)));
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">KNOWLEDGE / 03</span>
          <h1>菜品资料</h1>
          <p>从原始菜库到可追溯的出品标准。</p>
        </div>
        <div className="actions">
          <button
            onClick={() =>
              run(async () => {
                setMaterials(await request("/materials"));
                return "资料清单已读取";
              })
            }
          >
            <FolderOpen size={16} />
            资料清单
          </button>
          <ExportButton
            onClick={() =>
              downloadCsv(
                "菜品资料.csv",
                items.map((dish) => ({
                  dishId: dish.id,
                  stall: dish.stall,
                  dishName: dish.name,
                  price: dish.price,
                  unit: dish.unit,
                  原售价: dish.priceText,
                  辣度: dish.spicy,
                  素食: dish.vegetarian,
                  主料: dish.mainIngredient,
                  工艺: dish.method,
                  热量每100g: dish.calories,
                  过敏原: dish.allergens,
                  依据: dish.labelSource,
                })),
              )
            }
          />
        </div>
      </div>
      <div className="metrics">
        <Metric
          label="档口售卖项"
          value={data.dishes.length.toLocaleString()}
          detail={`${stalls.length} 个菜库分组`}
          icon={BookOpen}
        />
        <Metric
          label="已有英文名称"
          value={data.dishes.filter((dish) => dish.english).length}
          detail="来自原始翻译 · 待复核"
          icon={Languages}
          color="blue"
        />
        <Metric
          label="人工维护标签"
          value={data.dishes.filter((dish) => dish.verifiedAt).length}
          detail="保留核验依据"
          icon={ShieldCheck}
          color="gold"
        />
        <Metric
          label="源表公式错误"
          value={data.report.formulaErrors}
          detail="不作为有效成本"
          icon={CircleAlert}
          color="red"
        />
      </div>
      <section className="work-section">
        <div className="section-heading">
          <h2>档口菜品库</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={missing}
              onChange={(event) => {
                setMissing(event.target.checked);
                setPage(1);
              }}
            />
            仅看标签待核验
          </label>
        </div>
        <div className="filters">
          <label className="search">
            <Search size={17} />
            <input
              aria-label="搜索菜品"
              placeholder="搜索菜名或英文名称"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <select
            value={stall}
            aria-label="菜库档口"
            onChange={(event) => {
              setStall(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部档口</option>
            {stalls.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>菜品名称</th>
                <th>所属档口</th>
                <th>原售价</th>
                <th>辣度 / 素食</th>
                <th>热量 / 100g</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items
                .slice((currentPage - 1) * 12, currentPage * 12)
                .map((dish) => (
                  <tr key={dish.id}>
                    <td>
                      <strong>{dish.name}</strong>
                      <small className="english-name">
                        {dish.english || "英文名称待补充"}
                      </small>
                    </td>
                    <td>{dish.stall}</td>
                    <td className="nowrap">¥ {dish.priceText}</td>
                    <td>
                      <div className="badge-group">
                        <Badge
                          tone={
                            dish.spicy === "未知"
                              ? "gray"
                              : dish.spicy === "辣"
                                ? "red"
                                : "green"
                          }
                        >
                          {dish.spicy === "未知" ? "辣度待核验" : dish.spicy}
                        </Badge>
                        <Badge>
                          {dish.vegetarian === "未知"
                            ? "素食待核验"
                            : dish.vegetarian}
                        </Badge>
                      </div>
                    </td>
                    <td>
                      {dish.calories === null ? (
                        <span className="muted">待核验</span>
                      ) : (
                        `${dish.calories} kcal`
                      )}
                    </td>
                    <td>
                      <Badge tone={dish.active ? "green" : "red"}>
                        {dish.active ? "可选" : "停用"}
                      </Badge>
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        title={`编辑${dish.name}`}
                        aria-label={`编辑${dish.name}`}
                        onClick={() =>
                          run(async () => {
                            const evidence = await request(
                              `/recipes/${dish.id}`,
                            );
                            setRecipes(evidence);
                            setSelected(dish);
                            return "菜品资料已读取";
                          })
                        }
                      >
                        <Pencil size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!items.length && <Empty text="没有匹配的菜品" />}
        <Pagination page={currentPage} setPage={setPage} count={items.length} />
      </section>
      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(null)} wide>
          <div className="detail-meta">
            <Badge>{selected.stall}</Badge>
            <span>
              ¥ {selected.priceText} · {selected.id}
            </span>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const fields = Object.fromEntries(
                new FormData(event.currentTarget),
              );
              const input = {
                ...fields,
                active: fields.active === "on",
                calories:
                  fields.calories === "" ? null : Number(fields.calories),
              };
              run(async () => {
                await request(`/dishes/${selected.id}`, input, "PATCH");
                setSelected(null);
                return "菜品标签已保存";
              });
            }}
          >
            <div className="form-grid spaced">
              <Field label="辣度">
                <select name="spicy" defaultValue={selected.spicy}>
                  {["未知", "不辣", "辣"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
              <Field label="素食性">
                <select name="vegetarian" defaultValue={selected.vegetarian}>
                  {["未知", "素食", "非素食"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
              <Field label="主要食材">
                <input
                  name="mainIngredient"
                  defaultValue={selected.mainIngredient}
                />
              </Field>
              <Field label="制作工艺">
                <select name="method" defaultValue={selected.method}>
                  <option value="">待核验</option>
                  {["炒", "炖", "蒸", "煮", "炸", "烤", "凉拌", "其他"].map(
                    (value) => (
                      <option key={value}>{value}</option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="热量（kcal / 100g）">
                <input
                  name="calories"
                  type="number"
                  min="0"
                  max="900"
                  step="0.1"
                  defaultValue={selected.calories ?? ""}
                  placeholder="待核验"
                />
              </Field>
              <Field label="过敏原">
                <input
                  name="allergens"
                  defaultValue={selected.allergens}
                  placeholder="待核验"
                />
              </Field>
            </div>
            <Field label="标签核验依据">
              <input
                name="labelSource"
                required
                minLength={2}
                defaultValue={selected.labelSource}
                placeholder="配方版本、厨师确认或营养数据来源"
              />
            </Field>
            <label className="check">
              <input
                name="active"
                type="checkbox"
                defaultChecked={selected.active}
              />
              允许纳入排菜候选
            </label>
            <footer className="form-footer">
              <button className="primary" disabled={busy}>
                保存资料
              </button>
            </footer>
          </form>
          <h3>配方证据 · {recipes.length} 个版本</h3>
          <p className="muted small">
            按原始菜名精确匹配，不代表所属档口配方已审核。调料成分不完整时，不能据此确认无过敏原。
          </p>
          {recipes.map((recipe, index) => (
            <details key={index}>
              <summary>
                {recipe.source.sheet} · {recipe.source.row}行 · 缓存成本{" "}
                {recipe.cost === null
                  ? "无有效值"
                  : `¥${recipe.cost.toFixed(2)}`}
                {recipe.issues.length ? " · 含错误" : ""}
              </summary>
              <p className="source">{recipe.source.file}</p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>原料</th>
                      <th>熟重 g</th>
                      <th>生重 g</th>
                      <th>原料单价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipe.ingredients.map((ingredient, ingredientIndex) => (
                      <tr key={ingredientIndex}>
                        <td>{ingredient.name}</td>
                        <td>{ingredient.cookedGrams ?? "未知"}</td>
                        <td>
                          {ingredient.rawGrams === null
                            ? "未知"
                            : ingredient.rawGrams.toFixed(1)}
                        </td>
                        <td>{ingredient.pricePerKg ?? "未知"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
          {!recipes.length && <p className="muted">未找到同名配方证据。</p>}
          <details>
            <summary>菜库来源</summary>
            {selected.sources.map((source, index) => (
              <p className="source" key={index}>
                {source.file} / {source.sheet} / 行{source.row}
              </p>
            ))}
          </details>
        </Modal>
      )}
      {materials && (
        <Modal title="资料读取清单" onClose={() => setMaterials(null)} wide>
          <p className="notice">
            16个工作簿 · 69张工作表 · 22,365个非空行。行数不是反馈数或菜品数。
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>工作表</th>
                  <th>非空行</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((item) => (
                  <tr key={item.id}>
                    <td className="source">{item.source}</td>
                    <td>{item.sheet}</td>
                    <td>{item.rows}</td>
                    <td>{item.errors.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
  );
}
