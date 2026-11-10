"""Recalcula em Python, de forma independente, os números do painel de duplicidades de descontos.

Uso:
    python tests/conferir_totais.py <pasta>
    python tests/conferir_totais.py --desc desconto.xlsx --cad Cadastro_Interior.xlsx Cadastro_Leste.xlsx

Com <pasta>, segue a mesma regra do painel: o xlsx mais recente (data de modificação) da subpasta
Descontos e todos os xlsx da subpasta Cadastro. Opcional: --sup Interior (ou Leste) para filtrar.
Requer pandas e openpyxl.
"""
import argparse
import os
import sys
import unicodedata

import pandas as pd


def norm(s):
    s = unicodedata.normalize('NFD', str(s)).encode('ascii', 'ignore').decode()
    return '_'.join(s.strip().upper().split())


def sup_nome(s):
    n = norm(s)
    if n in ('LAGOS', 'INTERIOR'):
        return 'Interior'
    if n == 'LESTE':
        return 'Leste'
    return str(s).strip().capitalize()


def arquivos_da_pasta(pasta):
    desc, cad = [], []
    for raiz, _, nomes in os.walk(pasta):
        partes = [norm(p) for p in os.path.relpath(raiz, pasta).split(os.sep)]
        for n in nomes:
            if not n.lower().endswith('.xlsx') or n.startswith('~$'):
                continue
            c = os.path.join(raiz, n)
            if 'DESCONTOS' in partes:
                desc.append(c)
            elif 'CADASTRO' in partes:
                cad.append(c)
    desc.sort(key=os.path.getmtime, reverse=True)
    return desc[:1], cad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pasta', nargs='?')
    ap.add_argument('--desc')
    ap.add_argument('--cad', nargs='*', default=[])
    ap.add_argument('--sup')
    a = ap.parse_args()
    if a.pasta:
        desc, cad = arquivos_da_pasta(a.pasta)
    else:
        desc, cad = [a.desc], a.cad
    if not desc or not desc[0] or not cad:
        sys.exit('Informe a pasta ou --desc e --cad.')

    df = pd.read_excel(desc[0])
    df.columns = [norm(c) for c in df.columns]
    hora = df['DAT_ACESSO_HORA'].astype(str).str.slice(0, 8) if 'DAT_ACESSO_HORA' in df else '00:00:00'
    df['DT'] = pd.to_datetime(pd.to_datetime(df['DAT_ACESSO']).dt.strftime('%Y-%m-%d') + ' ' + hora)
    df['REF'] = pd.to_datetime(df['REFERENCIA']).dt.strftime('%Y-%m')
    df['CHAVE'] = df['EMP_CODIGO'].astype(int).astype(str) + '-' + df['NUM_LIGACAO'].fillna(0).astype('int64').astype(str)

    partes = []
    for f in cad:
        c = pd.read_excel(f)
        c.columns = [norm(x) for x in c.columns]
        if 'CHAVE_LIGACAO' not in c:
            c['CHAVE_LIGACAO'] = '*-' + c['NUM_LIGACAO'].astype('int64').astype(str)
        partes.append(c[['CHAVE_LIGACAO', 'CIDADE', 'SUPERINTENDENCIA']])
    cadastro = pd.concat(partes).drop_duplicates('CHAVE_LIGACAO', keep='last').set_index('CHAVE_LIGACAO')
    df['SUP'] = df['CHAVE'].map(cadastro['SUPERINTENDENCIA']).map(lambda s: sup_nome(s) if pd.notna(s) else None)

    total = len(df)
    sem_valor = df['DESCONTO'].isna() | df['VALOR_TOTAL'].isna()
    mat0 = ~sem_valor & ~(df['NUM_LIGACAO'] > 0)
    zero = ~sem_valor & ~mat0 & ~(df['DESCONTO'] > 0)
    valido = ~sem_valor & ~mat0 & ~zero
    fora = valido & df['SUP'].isna()
    base = df[valido & df['SUP'].notna()].copy()
    print(f'Arquivo de descontos: {os.path.basename(desc[0])}')
    print(f'Linhas: {total:,} | sem valores {sem_valor.sum()} | matrícula 0 {mat0.sum()} | desconto zero {zero.sum()} '
          f'| fora das superintendências {fora.sum():,} (R$ {df.loc[fora, "DESCONTO"].sum():,.2f}) | base {len(base):,}')
    if a.sup:
        base = base[base['SUP'] == a.sup]
        print(f'Filtro: {a.sup}')

    base['C'] = (base['DESCONTO'] * 100).round().astype('int64')
    base['T'] = (base['VALOR_TOTAL'] * 100).round().astype('int64')
    base = base.sort_values(['DT', 'NUM_LOG'])

    print(f'\nLançamentos analisados: {len(base):,} | R$ {base["DESCONTO"].sum():,.2f} | matrículas {base["NUM_LIGACAO"].nunique():,}')
    # 1) mesmo débito (matrícula + mês + total): um desconto = nível 1; descontos diferentes = nível 3
    kd = ['NUM_LIGACAO', 'REF', 'T']
    base['n_deb'] = base.groupby(kd)['C'].transform('size')
    base['nd_deb'] = base.groupby(kd)['C'].transform('nunique')
    base['ult_deb'] = ~base.duplicated(kd, keep='last')
    base['a_mais'] = (base.n_deb > 1) & ~base.ult_deb
    base['nivel'] = 0
    base.loc[base.a_mais, 'nivel'] = base.loc[base.a_mais, 'nd_deb'].map(lambda x: 1 if x == 1 else 3)
    grupos = [base[base.n_deb > 1].groupby(kd).agg(n=('C', 'size'), nd=('C', 'nunique')).assign(nivel=lambda x: x.nd.map(lambda v: 1 if v == 1 else 3))]
    # 2) do que sobrou de cada débito: mesmo desconto com total diferente = nível 2
    rest = base[~base.a_mais]
    k2 = ['NUM_LIGACAO', 'REF', 'C']
    n2 = rest.groupby(k2)['T'].transform('size')
    ult2 = ~rest.duplicated(k2, keep='last')
    idx = rest.index[(n2 > 1) & ~ult2]
    base.loc[idx, 'a_mais'] = True
    base.loc[idx, 'nivel'] = 2
    g2 = rest[n2 > 1].groupby(k2).size()
    am = base[base.a_mais]
    qtd = {1: int((grupos[0].nivel == 1).sum()), 2: len(g2), 3: int((grupos[0].nivel == 3).sum())}
    print(f'Matrículas com duplicidade: {am["NUM_LIGACAO"].nunique():,}')
    print(f'Lançamentos a mais: {len(am):,} em {sum(qtd.values()):,} descontos repetidos')
    print(f'Valor registrado em duplicidade: R$ {am["DESCONTO"].sum():,.2f}')
    for n in (1, 2, 3):
        x = am[am.nivel == n]
        print(f'  Nível {n}: {qtd[n]:,} descontos repetidos, {len(x):,} lançamentos a mais, R$ {x["DESCONTO"].sum():,.2f}')

    al = base.groupby(['NUM_LIGACAO', 'C']).agg(nr=('REF', 'nunique'))
    al = al[al.nr > 1]
    print(f'Alerta entre meses: {len(al):,} descontos, {al.reset_index()["NUM_LIGACAO"].nunique():,} matrículas')

    ve = base[~base.a_mais].groupby(['NUM_LIGACAO', 'REF']).agg(nd=('C', 'nunique'))
    ve = ve[ve.nd > 1]
    print(f'A verificar: {ve.reset_index()["NUM_LIGACAO"].nunique():,} matrículas, {len(ve):,} combinações de matrícula e mês')

    print('\nPor mês (lançamentos a mais: nível 1 / nível 2 / nível 3 / total / R$):')
    t = am.groupby(['REF', 'nivel']).size().unstack(fill_value=0).reindex(columns=[1, 2, 3], fill_value=0)
    v = am.groupby('REF')['DESCONTO'].sum()
    for ref, r in t.iterrows():
        print(f'  {ref}: {r[1]:>4} / {r[2]:>4} / {r[3]:>4} / {r.sum():>4} / R$ {v[ref]:,.2f}')


if __name__ == '__main__':
    main()
